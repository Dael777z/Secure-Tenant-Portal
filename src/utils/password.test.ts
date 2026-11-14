import { describe, expect, it } from "vitest"

import { isTooCommon } from "./password"

describe("isTooCommon", () => {
    it("refuses the passwords an attacker tries first, whatever the capitals or trailing digits", () => {
        for (const bad of ["12345678", "123456789", "1234567890", "87654321", "11111111", "12121212", "aaaaaaaa", "password", "Password", "PASSWORD1", "Password123!", "qwertyuiop", "Qwerty123", "abcdefgh", "letmein99", "iloveyou", "Summit2026", "welcome1"]) {
            expect(isTooCommon(bad), bad).toBe(true)
        }
    })

    it("accepts ordinary passwords and long passphrases, with no rule about symbols or digits", () => {
        for (const ok of ["tenant-demo-password", "correct horse battery staple", "blue.kettle.window", "Rx7!mLq92z", "my dog is called Biscuit", "thisisfine2026"]) {
            expect(isTooCommon(ok), ok).toBe(false)
        }
    })
})
