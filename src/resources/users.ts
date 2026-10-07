import { type SalesforceConnection, segment } from "../http/connection";

/** User password management (`/sobjects/User/{id}/password`). Needs the "Manage Users" permission. */
export class UsersApi {
	constructor(private readonly _connection: SalesforceConnection) {}

	/** `GET /sobjects/User/{id}/password`: whether the user's password has expired. */
	async passwordExpired(userId: string, options: { signal?: AbortSignal } = {}): Promise<boolean> {
		const result = await this._connection.request<{ isExpired: boolean }>({
			path: this.passwordPath(userId),
			signal: options.signal,
		});
		return result.isExpired;
	}

	/** `POST /sobjects/User/{id}/password`: sets a new password. */
	async setPassword(userId: string, newPassword: string, options: { signal?: AbortSignal } = {}): Promise<void> {
		if (typeof newPassword !== "string" || newPassword.length === 0) {
			throw new Error("setPassword() requires a new password.");
		}
		await this._connection.request({
			method: "POST",
			path: this.passwordPath(userId),
			body: { NewPassword: newPassword },
			signal: options.signal,
		});
	}

	/**
	 * `DELETE /sobjects/User/{id}/password`: resets the password. The current password stops working,
	 * the user gets an email with a reset link, and the temporary password is returned.
	 */
	async resetPassword(userId: string, options: { signal?: AbortSignal } = {}): Promise<string> {
		const result = await this._connection.request<{ NewPassword: string }>({
			method: "DELETE",
			path: this.passwordPath(userId),
			signal: options.signal,
		});
		return result.NewPassword;
	}

	private passwordPath(userId: string): string {
		if (typeof userId !== "string" || userId.trim().length === 0) {
			throw new Error("A user id is required.");
		}
		return `/sobjects/User/${segment(userId)}/password`;
	}
}
