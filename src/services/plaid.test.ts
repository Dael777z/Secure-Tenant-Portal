import { describe, expect, it } from "vitest"

import { describePlaidFailure } from "./plaid"

describe("describePlaidFailure", () => {
    it("reads plaid's error object off an http error", () => {
        const error = {
            message: "Request failed with status code 400",
            response: {
                status: 400,
                data: { error_type: "INVALID_REQUEST", error_code: "INVALID_FIELD", error_message: "redirect_uri must be added to the allowed list", display_message: null, request_id: "req123" },
            },
        }
        expect(describePlaidFailure(error)).toEqual({
            status: 400, type: "INVALID_REQUEST", code: "INVALID_FIELD",
            message: "redirect_uri must be added to the allowed list", displayMessage: null, requestId: "req123",
        })
    })

    it("names a network failure when plaid never answered", () => {
        expect(describePlaidFailure({ code: "ECONNREFUSED", message: "connect ECONNREFUSED" })).toMatchObject({
            status: null, type: "NETWORK", code: "ECONNREFUSED", message: "connect ECONNREFUSED",
        })
    })
})
