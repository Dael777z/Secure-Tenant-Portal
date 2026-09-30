# Friday progress demo


## What is in this copy

- The manager's left sidebar shows only **Dashboard** and **Properties**. On a phone the bottom bar shows Home, Properties and More (for signing out).
- Nothing else is removed. The buttons across the top of the Dashboard still add things: **+ New lease, + Add property, + Add unit, Record a payment, Charge or credit, Maintenance request, Message a resident**. Links on the dashboard (for example "Overdue Accounts") still open their pages.
- It keeps **its own database and settings** (in `%LOCALAPPDATA%\ResidentPortal-FridayTest`). Starting it, or pressing Reset Demo Data here, never touches the main project's data. The first time it runs on a PC, it downloads Node.js and PostgreSQL (about 330 MB, one time only, no installer or admin rights needed); after that it starts in seconds.
- It opens at **http://localhost:4100** (or the next free port), so it can run alongside the main project.

## Running it

1. Double-click **Start Portal.cmd** in this folder. 
2. Sign in as the manager:
   - Email: `manager@seniorproject.example`
   - Password: `SeniorProject2026`
3. When you are done, double-click **Stop Portal.cmd**.

The portal starts **blank**: only the manager sign-in exists. There are no properties, units, residents, leases, payments or maintenance requests until you enter them live. To wipe anything you typed in while practising, double-click **Reset Demo Data.cmd** (it asks first), then Start Portal.cmd.

## A five-minute walk-through

1. **Sign in** as the manager. The Dashboard starts empty; it fills in as you add properties, units and leases.
2. **+ Add property**: add a building. It appears under **Properties**.
3. Open it and **+ Add unit**; add a photo of the building or a unit.
4. **+ New lease** on a vacant unit, with a second resident on the same lease. The portal shows each person a temporary password once.
5. **Charge or credit** and **Record a payment** on that lease; both show up on the lease's ledger.
6. **Maintenance request** and **Message a resident** open the same forms the full portal uses.
