/**
 * Passwords people choose. Length alone lets "12345678" through, and that is what
 * guessing attacks try first, so the very common ones are refused as well. The rule is
 * deliberately small: no required symbols or digits (they push people to "Password1!"),
 * and long passphrases are welcome.
 */
const COMMON = new Set([
    "password", "passw0rd", "p@ssword", "p@ssw0rd", "qwertyui", "qwerty", "qwertyuiop", "asdfghjk", "asdfghjkl", "zxcvbnm", "zxcvbnm1",
    "letmein", "welcome", "welcome1", "admin", "administrator", "iloveyou", "monkey", "dragon", "football", "baseball", "sunshine",
    "princess", "superman", "trustno1", "changeme", "default", "secret", "master", "login", "abc123", "abcd1234", "abcdefgh",
    "summit", "portal", "tenant", "manager", "resident", "apartment", "landlord",
])

/** Lower case, with trailing digits and punctuation removed: "Password123!" becomes "password". */
const stem = (value: string) => value.toLowerCase().replace(/[\d\s!@#$%^&*._-]+$/, "")

/** True when the password is one of the first things an attacker would try. */
export function isTooCommon(password: string): boolean {
    const lower = password.toLowerCase()
    if (COMMON.has(lower) || COMMON.has(stem(password))) return true
    if (new Set(lower).size <= 2) return true                       // "aaaaaaaa", "12121212"
    const digits = lower.replace(/\D/g, "")
    if (digits === lower && /^(?:0123456789|1234567890|123456789|12345678|01234567|23456789|87654321|987654321|9876543210)/.test(digits)) return true
    return /^(?:abcdefgh|abcdefghi|abcdefghij|qwertyuiop?|asdfghjkl?)$/.test(lower)
}
