---
"@cerios/salesforce-sobjectly": minor
---

Request hooks now receive the request body (`body`) and the response body (`responseBody`), so a hook can log calls to the console or attach them to a test report such as Allure. Hooks may return a promise; it is not awaited and a rejection is ignored.
