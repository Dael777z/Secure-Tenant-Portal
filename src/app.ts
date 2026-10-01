import express, { type Application, type Request, type Response } from "express"
import cookieParser from "cookie-parser"

import type { DatabaseInterface } from "./types/interfaces"

import { env } from "./config/env"
import { errorHandler } from "./middleware/errors"

import { createAuthRouter } from "./routes/auth"
import { createDatabase, createLogger } from "./utils/init"

import { context } from "./middleware/context"
import { logging } from "./middleware/logging"
import { verifyRequestOrigin } from "./middleware/origin"
import { resolve } from "node:path"

const distRoot = resolve(__dirname, "..")

const app: Application = express()
const database: DatabaseInterface = createDatabase()
const logger = createLogger()

app.set("trust proxy", 1)

app.get("/favicon.ico", (_req: Request, res: Response) => {
  res.status(204).end()
})

// middleware
app.use(context)
app.use(express.json())
app.use(cookieParser())
app.use(verifyRequestOrigin)
app.use(logging(logger))

app.use("/api", createAuthRouter(database))
// app.use("/api", createPlaidRouter() )
// etc.

app.use(express.static(distRoot))


// wildcard get route for SPA
app.get("/{*splat}", (req, res) => {
  if (req.path.startsWith("/api")) {
    res.status(404).json({ error: "NOT_FOUND"})
    return
  }

  res.sendFile("index.html", {root: distRoot})
})

app.use(errorHandler(logger))

const server = app.listen(env.port, "0.0.0.0", () => {
  logger.info("server.started", {
    address: `0.0.0.0:${env.port}`,
  })
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
        logger.info("server.stopped")
    })
})
}