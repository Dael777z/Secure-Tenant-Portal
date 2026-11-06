import { Router } from "express"

import type { Auth } from "../middleware/auth"
import type { RateLimits } from "../middleware/rate-limit"
import type { LeasingService } from "../services/leasing-service"
import type { LeadInput, LeadStatus, ListingInput } from "../types/additions"
import { AppError } from "../types/errors"
import { date, id, money, text } from "./validate"

/**
 * Listings and leads (009), and the public listings page's API (no sign-in).
 *
 *   GET    /manager/listings                     with lead counts and Zillow's status
 *   POST   /manager/listings      { unitId, title, askingRent, ... }   a draft
 *   GET    /manager/listings/:id                 with its leads (leadList)
 *   PUT    /manager/listings/:id  { title, askingRent, ... }
 *   POST   /manager/listings/:id/publish         draft → listed on /listings
 *   POST   /manager/listings/:id/end             off the market (kept as history)
 *   DELETE /manager/listings/:id                 drafts only
 *   GET    /manager/leads
 *   POST   /manager/listings/:id/leads { name, email?, phone?, message? }
 *   PUT    /manager/leads/:id     { status: new|contacted|closed }
 *
 *   GET    /public/listings                      published homes
 *   GET    /public/listings/:id/photos/:photoId  the building's and unit's photos
 *   POST   /public/listings/:id/inquire { name, email?, phone?, message?, website }   becomes a lead
 */
export function createLeasingRouter(deps: { leasing: LeasingService; guard: Auth; limits: RateLimits }): Router {
    const { leasing, guard, limits } = deps
    const { can } = guard
    const router = Router()

    const optional = (value: unknown, max: number) => text(value, max, { optional: true })
    const half = (value: unknown) => {
        if (value === null || value === undefined || value === "") return null
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 20 || value * 2 !== Math.round(value * 2)) throw new AppError("VALIDATION_ERROR")
        return value
    }
    const listing = (body: Record<string, unknown>): ListingInput => {
        const amenities = body.amenities === undefined ? [] : body.amenities
        if (!Array.isArray(amenities) || amenities.length > 40 || amenities.some((a) => typeof a !== "string" || !a.trim() || a.trim().length > 60)) throw new AppError("VALIDATION_ERROR")
        const sqft = body.sqft === null || body.sqft === undefined || body.sqft === "" ? null : body.sqft
        if (sqft !== null && (typeof sqft !== "number" || !Number.isInteger(sqft) || sqft < 0 || sqft > 100_000)) throw new AppError("VALIDATION_ERROR")
        return {
            title: text(body.title, 120)!,
            description: optional(body.description, 4000),
            askingRent: money(body.askingRent),
            availableOn: date(body.availableOn, { optional: true }),
            beds: half(body.beds),
            baths: half(body.baths),
            sqft: sqft as number | null,
            amenities: (amenities as string[]).map((a) => a.trim()),
            pets: optional(body.pets, 200),
        }
    }
    const lead = (body: Record<string, unknown>): LeadInput => {
        const email = optional(body.email, 255)
        const phone = optional(body.phone, 40)
        if (email !== null && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AppError("VALIDATION_ERROR")
        if (phone !== null && !/^[0-9+().\-\s]{7,40}$/.test(phone)) throw new AppError("VALIDATION_ERROR")
        if (email === null && phone === null) throw new AppError("VALIDATION_ERROR")
        return { name: text(body.name, 120)!, email, phone, message: optional(body.message, 2000) }
    }

    router.get("/manager/listings", ...can("ledger:read:property"), async (_req, res) => {
        res.json(await leasing.listings())
    })

    router.post("/manager/listings", limits.sensitive, ...can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        res.status(201).json({ id: await leasing.create(id(body.unitId), listing(body)) })
    })

    router.get("/manager/listings/:id", ...can("ledger:read:property"), async (req, res) => {
        res.json(await leasing.listing(id(req.params.id)))
    })

    router.put("/manager/listings/:id", limits.sensitive, ...can("users:provision"), async (req, res) => {
        await leasing.update(id(req.params.id), listing(req.body as Record<string, unknown>))
        res.json({ ok: true })
    })

    router.post("/manager/listings/:id/publish", limits.sensitive, ...can("users:provision"), async (req, res) => {
        await leasing.publish(id(req.params.id))
        res.json({ ok: true })
    })

    router.post("/manager/listings/:id/end", limits.sensitive, ...can("users:provision"), async (req, res) => {
        await leasing.end(id(req.params.id))
        res.json({ ok: true })
    })

    router.delete("/manager/listings/:id", limits.sensitive, ...can("users:provision"), async (req, res) => {
        await leasing.removeDraft(id(req.params.id))
        res.json({ ok: true })
    })

    router.get("/manager/leads", ...can("ledger:read:property"), async (_req, res) => {
        res.json({ leads: await leasing.leads() })
    })

    router.post("/manager/listings/:id/leads", limits.sensitive, ...can("users:provision"), async (req, res) => {
        res.status(201).json({ id: await leasing.addLead(id(req.params.id), lead(req.body as Record<string, unknown>)) })
    })

    router.put("/manager/leads/:id", limits.sensitive, ...can("users:provision"), async (req, res) => {
        const status = (req.body as Record<string, unknown>).status
        if (status !== "new" && status !== "contacted" && status !== "closed") throw new AppError("VALIDATION_ERROR")
        await leasing.setLeadStatus(id(req.params.id), status as LeadStatus)
        res.json({ ok: true })
    })

    /* ---- Public (no sign-in) ---- */

    router.get("/public/listings", async (_req, res) => {
        res.set("Cache-Control", "public, max-age=60")
        res.json({ listings: await leasing.publicListings() })
    })

    router.get("/public/listings/:id/photos/:photoId", async (req, res) => {
        const photo = await leasing.publicPhoto(id(req.params.id), id(req.params.photoId))
        res.set({ "Content-Type": photo.contentType, "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=3600" })
        res.send(photo.data)
    })

    router.post("/public/listings/:id/inquire", limits.sensitive, async (req, res) => {
        const body = req.body as Record<string, unknown>
        // The form's hidden "website" field: people leave it empty, form-filling bots don't. Pretend it worked.
        if (typeof body.website === "string" && body.website.trim()) return void res.status(201).json({ ok: true })
        await leasing.inquire(id(req.params.id), lead(body))
        res.status(201).json({ ok: true })
    })

    return router
}
