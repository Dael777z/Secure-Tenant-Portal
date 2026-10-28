import { existsSync } from "node:fs"
import { resolve } from "node:path"

import { createContainer, type Container } from "./container"
import { createApp } from "./create-app"

/**
 * Start the server: build everything (container.ts), check the database,
 * listen, and keep rent charges current. Database setup is not done here;
 * the app's login cannot change the schema. That is `npm run db setup`
 * (which `npm run dev` runs first).
 */
async function main() {
    // The built frontend sits next to the built server (dist/ and dist/server/). In development Vite serves it.
    const builtFrontend = resolve(__dirname, "..")
    let container: Container | undefined
    try {
        container = createContainer({ distRoot: existsSync(resolve(builtFrontend, "index.html")) ? builtFrontend : undefined })
        await container.checkDatabase()
    } catch (error) {
        console.error(`\n  Cannot start: ${(error as Error).message}\n`)
        await container?.close()
        process.exit(1)
    }
    const { config, logger } = container

    const server = createApp(container).listen(config.port, "0.0.0.0", () => {
        logger.info("server.started", { port: config.port, mode: config.mode, plaid: container.plaid ? config.plaidEnv : "off", frontend: container.distRoot ? "built" : "vite" })
    })
    // Bill the months that came due while the app was down, then keep doing it.
    container.rentCharges.start()

    const stop = () => server.close(() => {
        logger.info("server.stopped")
        void container!.close()
    })
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
}

void main()
