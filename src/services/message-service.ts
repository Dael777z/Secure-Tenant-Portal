import { AppError } from "../types/errors"
import type { Conversation, Message, TenantConversation, ThreadSummary } from "../types/messages"
import type { MessageRecord, ThreadRecord } from "../types/records"
import type { MessagingStore } from "../types/stores"
import { parseUserId, tenantIdOf } from "../utils/user-id"
import { localDate } from "./ledger"

/**
 * Messages between a tenant and the property office (004). Each tenant has one
 * conversation; every property manager shares the office side. Opening a
 * conversation marks the other side's messages read: that is the receipt each
 * side sees. Row-level security enforces who may read and write what.
 */
export class MessageService {
    constructor(
        private readonly db: MessagingStore,
        private readonly timeZone: string,
    ) {}

    private today(): string {
        return localDate(new Date(), this.timeZone)
    }

    // ---- The office

    /** The inbox, or the archived conversations. */
    async threads(archived: boolean): Promise<ThreadSummary[]> {
        return (await this.db.listThreads(archived, this.today())).map(toSummary)
    }

    /** For the sidebar badge. */
    unreadThreads(): Promise<number> {
        return this.db.countUnreadThreads()
    }

    /** One tenant's conversation (empty when nobody has written yet). Reading it does not mark it read: see `markReadByOffice`. */
    async conversation(tID: number): Promise<Conversation> {
        const person = await this.db.findPerson(tID)
        if (!person) throw new AppError("NOT_FOUND")
        const [thread, lease, messages] = await Promise.all([
            this.db.findThread(tID, this.today()),
            this.db.findCurrentLease(tID, this.today()),
            this.db.listMessages(tID),
        ])
        const unitLabel = lease ? `Unit ${lease.unitNum} - ${lease.propertyName}` : labelOf(thread)
        return {
            tenant: { id: tID, name: person.name, email: person.email, phone: person.phone, unitLabel, leaseId: lease?.id ?? thread?.leaseId ?? null },
            archived: thread?.archived ?? false,
            messages: messages.map(toMessage),
        }
    }

    /** The manager opened the conversation: the tenant's messages are now read. */
    markReadByOffice(tID: number): Promise<number> {
        return this.db.markMessagesRead(tID, "tenant")
    }

    async reply(staffUserId: string, tID: number, body: string): Promise<Message> {
        const staff = parseUserId(staffUserId)
        if (!staff || staff.table !== "admin") throw new AppError("FORBIDDEN")
        if (!(await this.db.findPerson(tID))) throw new AppError("NOT_FOUND")
        return toMessage(await this.db.sendMessage({ tenantId: tID, adminId: staff.id, body }))
    }

    setArchived(tID: number, archived: boolean): Promise<void> {
        return this.db.setThreadArchived(tID, archived)
    }

    // ---- The tenant

    async tenantConversation(userId: string): Promise<TenantConversation> {
        const messages = (await this.db.listMessages(tenantIdOf(userId))).map(toMessage)
        return { messages, unread: messages.filter((m) => m.from === "office" && !m.readAt).length }
    }

    async tenantSend(userId: string, body: string): Promise<Message> {
        return toMessage(await this.db.sendMessage({ tenantId: tenantIdOf(userId), adminId: null, body }))
    }

    /** The tenant opened the conversation: the office's messages are now read. */
    markReadByTenant(userId: string): Promise<number> {
        return this.db.markMessagesRead(tenantIdOf(userId), "office")
    }
}

const labelOf = (thread: ThreadRecord | null) => (thread?.unitNum ? `Unit ${thread.unitNum} - ${thread.propertyName}` : null)

function toMessage(m: MessageRecord): Message {
    return {
        id: m.id,
        from: m.fromOffice ? "office" : "tenant",
        senderName: m.senderName,
        body: m.body,
        sentAt: m.sentAt.toISOString(),
        readAt: m.readAt ? m.readAt.toISOString() : null,
    }
}

function toSummary(t: ThreadRecord): ThreadSummary {
    return {
        tenantId: t.tenantId,
        tenantName: t.tenantName,
        unitLabel: labelOf(t),
        leaseId: t.leaseId,
        lastMessage: { body: t.lastBody, from: t.lastFromOffice ? "office" : "tenant", sentAt: t.lastMessageAt.toISOString() },
        unread: t.unread,
        archived: t.archived,
    }
}
