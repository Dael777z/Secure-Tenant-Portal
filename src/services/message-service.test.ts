import { describe, expect, it } from "vitest"

import { MessageService } from "./message-service"

// Staff-only checks that sit in front of the database: a stand-in store is enough.
const service = (person: unknown) => new MessageService({ findPerson: async () => person, sendMessage: async () => { throw new Error("must not be reached") } } as never, "America/Denver")

describe("MessageService.reply", () => {
    it("only a staff account can reply: a tenant id or nonsense is FORBIDDEN", async () => {
        for (const who of ["tenant:3", "nonsense", ""]) {
            await expect(service({ name: "T" }).reply(who, 5, "hello"), who).rejects.toMatchObject({ code: "FORBIDDEN" })
        }
    })
    it("replying to a tenant who does not exist is NOT_FOUND", async () => {
        await expect(service(null).reply("admin:1", 999, "hello")).rejects.toMatchObject({ code: "NOT_FOUND" })
    })
})
