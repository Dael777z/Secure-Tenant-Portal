import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { PublicListingsPage } from "./public/PublicListings";
// Stylesheets in cascade order: the theme's tokens first, then the screens that use them.
import "./theme/theme.css";
import "./manager/additions.css";
import "./manager/manager.css";
import "./styles/portal.css";
import "./public/public.css";

// /listings is the public "Homes for rent" page (no sign-in); everything else is the portal.
const publicListings = window.location.pathname.replace(/\/+$/, "") === "/listings";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{publicListings ? <PublicListingsPage /> : <App />}</React.StrictMode>
);
