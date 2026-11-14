import { currentIdentity } from "../db/identity"
import { silentLogger, type LogMetadata, type LogService } from "../logging"
import type { LeadInput, LeadRow, LeadStatus, ListingInput, ListingRow, PublicListing } from "../types/additions"
import { AppError } from "../types/errors"
import type { AdditionsStore } from "../types/stores"

/** What the Listings page says about Zillow: not connected (syndication needs an approved feed). */
export const ZILLOW = {
    status: "not_connected" as const,
    label: "Not Connected — Future Integration",
    detail: "Listings are not sent to Zillow. Connecting needs an approved Zillow Rental Network feed; until then, share the public listings page link.",
}

/**
 * Listings and leads (009). The office drafts a listing for a unit, publishes
 * it to the public /listings page (no sign-in), and ends it when the unit is
 * rented. Inquiries from the page arrive as leads; the office can add leads
 * from calls or walk-ins too.
 */
export class LeasingService {
    constructor(private readonly db: AdditionsStore, private readonly log: LogService = silentLogger) {}

    private change<T>(event: string, metadata: LogMetadata, work: () => Promise<T>): Promise<T> {
        const who = currentIdentity()
        return this.log.flow(event, { by: "id" in who ? `${who.type}:${who.id}` : who.type, ...metadata }, work)
    }

    async listings(): Promise<{ listings: ListingRow[]; zillow: typeof ZILLOW }> {
        return { listings: await this.db.listListings(), zillow: ZILLOW }
    }

    async listing(id: number): Promise<ListingRow & { leadList: LeadRow[] }> {
        const listing = await this.db.findListing(id)
        if (!listing) throw new AppError("NOT_FOUND")
        return { ...listing, leadList: await this.db.listLeads(id) }
    }

    create(unitId: number, input: ListingInput): Promise<number> {
        return this.change("office.listing.create", { unitId }, () => this.db.createListing(unitId, input))
    }

    update(id: number, input: ListingInput): Promise<void> {
        return this.change("office.listing.update", { listingId: id }, () => this.db.updateListing(id, input))
    }

    publish(id: number): Promise<void> {
        return this.change("office.listing.publish", { listingId: id }, () => this.db.setListingStatus(id, "active"))
    }

    end(id: number): Promise<void> {
        return this.change("office.listing.end", { listingId: id }, () => this.db.setListingStatus(id, "ended"))
    }

    removeDraft(id: number): Promise<void> {
        return this.change("office.listing.remove", { listingId: id }, () => this.db.removeDraftListing(id))
    }

    leads(): Promise<LeadRow[]> {
        return this.db.listLeads()
    }

    addLead(listingId: number, input: LeadInput): Promise<number> {
        return this.change("office.lead.add", { listingId }, () => this.db.addLead(listingId, input))
    }

    setLeadStatus(id: number, status: LeadStatus): Promise<void> {
        return this.change("office.lead.status", { leadId: id, status }, () => this.db.setLeadStatus(id, status))
    }

    /* ---- The public page ---- */

    publicListings(): Promise<PublicListing[]> {
        return this.db.publicListings()
    }

    async publicPhoto(listingId: number, imageId: number) {
        const photo = await this.db.publicListingPhoto(listingId, imageId)
        if (!photo) throw new AppError("NOT_FOUND")
        return photo
    }

    /** NOT_FOUND when the home is no longer listed. */
    async inquire(listingId: number, input: LeadInput): Promise<number> {
        const id = await this.log.flow("public.listing.inquire", { listingId }, () => this.db.publicInquire(listingId, input))
        if (id === null) throw new AppError("NOT_FOUND")
        return id
    }
}
