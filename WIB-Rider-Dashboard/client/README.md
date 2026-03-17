# WIB Rider Dashboard – React UI

React app with the dashboard UI: red header, Tasks | Map | Agent layout, and separate pages.

## Development

From repo root (WIB Rider Dashboard):

- **API server:** `npm start` (port 3002, serves API and built app if present).
- **React dev server:** `npm run dev:client` (port 5173, Vite; proxies `/api` to 3002).

Use **http://localhost:5173** during development so the React app talks to the Node API.

## Build for production

From repo root:

```bash
npm run build
npm start
```

Then open **http://localhost:3002**. The server serves the built app from `client/dist`.

## Routes (React Router)

- `/` – Dashboard (Tasks panel | Map | Agent panel)
- `/tasks` – Full task list, assign modal
- `/drivers` – Drivers (agents) list
- `/new-task` – Create task form
- `/settings` – General settings
- `/teams` – Teams list
- `/push-logs` – Driver push logs
