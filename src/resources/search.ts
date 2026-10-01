import type { SalesforceConnection } from "../http/connection";
import type { ParameterizedSearchRequest, SearchResult, SearchSuggestionsResult } from "../types/api";
import type { GenericRecord } from "../types/common";

export interface SearchSuggestionsOptions {
	/** The search text (at least 3 characters for most objects). */
	q: string;
	sobject: string;
	fields?: string[];
	limit?: number;
	where?: string;
	useSearchScope?: boolean;
	signal?: AbortSignal;
}

/** SOSL search, parameterized search and search suggestions. */
export class SearchApi {
	constructor(private readonly _connection: SalesforceConnection) {}

	/**
	 * Runs a SOSL query, e.g. `FIND {Acme*} IN NAME FIELDS RETURNING Account(Id, Name)`.
	 * Escape user input in the `FIND {...}` term with `soslEscape`.
	 */
	sosl<T = GenericRecord>(query: string, options: { signal?: AbortSignal } = {}): Promise<SearchResult<T>> {
		if (typeof query !== "string" || query.trim().length === 0) {
			throw new Error("sosl() requires a non-blank SOSL string.");
		}
		return this._connection.request({ path: "/search", query: { q: query }, signal: options.signal });
	}

	/** `POST /parameterizedSearch`: search without writing SOSL. */
	parameterized<T = GenericRecord>(
		request: ParameterizedSearchRequest,
		options: { signal?: AbortSignal } = {},
	): Promise<SearchResult<T>> {
		return this._connection.request({
			method: "POST",
			path: "/parameterizedSearch",
			body: request,
			signal: options.signal,
		});
	}

	/** `GET /search/suggestions`: auto-suggest records matching the start of a term. */
	suggestions<T = GenericRecord>(options: SearchSuggestionsOptions): Promise<SearchSuggestionsResult<T>> {
		const { signal, ...query } = options;
		return this._connection.request({ path: "/search/suggestions", query, signal });
	}
}
