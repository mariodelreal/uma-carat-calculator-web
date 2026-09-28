/**
 * The /plans routes: create, rename, switch, copy and delete a signed-in user's
 * pull plans. Shapes and status codes: backend/docs/api-reference.md ("Plans").
 *
 * Banner ROWS are not saved here. They still go through
 * userCalculatorDataPatch (calculatorFetchCalls.ts) with a `planId`, because
 * the auto-save sends stats, banners, purchases and selections as one
 * transaction on the server.
 *
 * Every call returns the raw Response, like the rest of the fetch modules, so
 * the provider decides what a failure means.
 */
import { authHeaders } from "./authToken"

const API_URL = import.meta.env.VITE_API_URL

const jsonHeaders = (): HeadersInit => ({
	"Content-Type": "application/json",
	...authHeaders()
})

/** One plan and its rows. What a switch fetches, instead of the ~1 MB catalogue. */
export function planFetch(planId: number): Promise<Response> {
	return fetch(`${API_URL}/plans/${planId}`, {
		method: "GET",
		headers: jsonHeaders()
	})
}

/** A read-only plan view addressed by its public share identifier. */
export function planFetchPublic(publicId: string): Promise<Response> {
	return fetch(`${API_URL}/plans/public/${encodeURIComponent(publicId)}`, {
		method: "GET"
	})
}

/**
 * A new plan, blank or copied from another of the caller's plans. The server
 * creates it INACTIVE; switching to it is a separate planActivate call, made
 * after the pending save for the plan being left has been flushed.
 */
export function planCreate(name: string, copyFromId?: number): Promise<Response> {
	return fetch(`${API_URL}/plans`, {
		method: "POST",
		headers: jsonHeaders(),
		body: JSON.stringify({
			name,
			...(copyFromId !== undefined ? { copy_from: copyFromId } : {})
		})
	})
}

export function planRename(planId: number, name: string): Promise<Response> {
	return fetch(`${API_URL}/plans/${planId}`, {
		method: "PATCH",
		headers: jsonHeaders(),
		body: JSON.stringify({ name })
	})
}

/**
 * Makes this the plan the calculator opens on next time. There is no
 * deactivate: an account always has one active plan, so the way to leave a
 * plan is to activate another.
 */
export function planActivate(planId: number): Promise<Response> {
	return fetch(`${API_URL}/plans/${planId}`, {
		method: "PATCH",
		headers: jsonHeaders(),
		body: JSON.stringify({ is_active: true })
	})
}

/**
 * Give this plan its own resources and income settings (`on`), or send it back
 * to the account's (`off`). The server seeds the new copy from the stats the
 * plan reads today and answers with the Plan only; the provider follows up
 * with planFetch for the stats, the same path a switch uses.
 */
export function planSetSeparateIncome(planId: number, on: boolean): Promise<Response> {
	return fetch(`${API_URL}/plans/${planId}`, {
		method: "PATCH",
		headers: jsonHeaders(),
		body: JSON.stringify({ separate_income: on })
	})
}

/** Resolves to `{ active_plan_id }`: where the account landed afterwards. */
export function planDelete(planId: number): Promise<Response> {
	return fetch(`${API_URL}/plans/${planId}`, {
		method: "DELETE",
		headers: jsonHeaders()
	})
}
