import express, { type Application, type Request, type Response } from "express"
import cors from "cors"
import cookieParser from "cookie-parser"

import type { DatabaseInterface } from "./types/interfaces"

import { env } from "./config/env"
import { errorHandler } from "./middleware/errors"

import { createApiRouter } from "./routes/api"
import { createDatabase, createLogger } from "./utils/init"

import { context } from "./middleware/context"
import { logging } from "./middleware/logging"
import { verifyRequestOrigin } from "./middleware/origin"

const app: Application = express()
const database: DatabaseInterface = createDatabase()
const logger = createLogger()

app.get("/favicon.ico", (_req: Request, res: Response) => {
  res.status(204).end()
})

app.use(context)
app.use(express.json())
app.use(cookieParser())
app.use(cors({ origin: env.webOrigin, credentials: true }))
app.use(verifyRequestOrigin)
app.use(logging(logger))
app.use("/api", createApiRouter(database))
app.use(errorHandler(logger))

const server = app.listen(env.port, env.networkInterface, () => {
  logger.info("server.started", {
    address: `http://${env.domainName}:${env.port}`,
  })
});

process.on("SIGINT", () => {
    server.close(() => {
        logger.info("server.stopped")
    })
})
