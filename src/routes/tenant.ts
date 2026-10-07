import { Router } from "express"

import { authenticateJWT } from "../middleware/auth"
import { requirePermission } from "../middleware/rbac"
import type { TenantStore } from "../services/tenant-store"
import { AppError } from "../types/errors"
import type { ValidRequest } from "../types/interfaces"

/**
 * /api/tenant/* — what Juan's tenant pages read and write (Scott's route
 * grouping: auth/, api/, tenant/). Every route acts as the signed-in tenant.
 */
export function createTenantRouter(store: TenantStore | null, options: { plaidEnabled: boolean }): Router {
    const router = Router()

    const need = (): TenantStore => {
        if (!store) throw new AppError("DATABASE_REQUIRED")
        return store
    }

    router.get("/tenant/summary", authenticateJWT, requirePermission("ledger:read:self"), async (req: ValidRequest, res) => {
        res.json(await need().summary(req.user!.id, options.plaidEnabled))
    })

    router.post("/tenant/payments", authenticateJWT, requirePermission("payment:create:self"), async (req: ValidRequest, res) => {
        const { amount, bankAccountId } = req.body as { amount?: unknown; bankAccountId?: unknown }
        if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 100_000 || Math.round(amount * 100) !== amount * 100) {
            throw new AppError("VALIDATION_ERROR")
        }
        if (bankAccountId !== undefined && bankAccountId !== null && (typeof bankAccountId !== "string" || !/^\d{1,9}$/.test(bankAccountId))) {
            throw new AppError("VALIDATION_ERROR")
        }
        const result = await need().recordPayment(req.user!.id, { amount, bankAccountId: (bankAccountId as string | null | undefined) ?? null })
        res.status(201).json(result)
    })

    router.post("/tenant/maintenance", authenticateJWT, requirePermission("maintenance:create"), async (req: ValidRequest, res) => {
        const { title, description } = req.body as { title?: unknown; description?: unknown }
        if (typeof title !== "string" || !title.trim() || title.trim().length > 120) throw new AppError("VALIDATION_ERROR")
        if (description !== undefined && (typeof description !== "string" || description.length > 4000)) throw new AppError("VALIDATION_ERROR")
        const request = await need().createMaintenance(req.user!.id, {
            title: title.trim(),
            description: typeof description === "string" ? description.trim() : "",
        })
        res.status(201).json(request)
    })

    return router
}
