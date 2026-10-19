// What the messages API returns (004). Times are ISO strings.

export interface Message {
    id: number
    from: "tenant" | "office"
    /** The manager who wrote it; null for the tenant's messages. */
    senderName: string | null
    body: string
    sentAt: string
    /** The receipt: when the other side opened the conversation. */
    readAt: string | null
}

/** A row in the office inbox. */
export interface ThreadSummary {
    tenantId: number
    tenantName: string
    unitLabel: string | null
    leaseId: number | null
    lastMessage: { body: string; from: Message["from"]; sentAt: string }
    unread: number
    archived: boolean
}

/** One conversation as the office sees it. */
export interface Conversation {
    tenant: { id: number; name: string; email: string; phone: string | null; unitLabel: string | null; leaseId: number | null }
    archived: boolean
    messages: Message[]
}

/** The tenant's conversation with the office. */
export interface TenantConversation {
    messages: Message[]
    /** The office's messages the tenant has not opened. */
    unread: number
}
