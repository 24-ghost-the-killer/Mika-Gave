import "@fontsource-variable/fraunces";
import "@fontsource-variable/fraunces/wght-italic.css";
import "@fontsource-variable/instrument-sans";
import "./styles/main.css";
import { start } from "./app";
import { t } from "./strings.da";
import { notice } from "./ui/overlay";

// The link token lives in the fragment, which is never sent to the server. Read it, then wipe it
// from the address bar and history straight away, so it isn't left on screen or shared by accident.
const token = location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : "";
if (location.hash) history.replaceState(null, "", location.pathname + location.search);

start(token).catch((err) => {
  console.error(err);
  notice(document.getElementById("ui")!, t.failed);
});

// A link pasted into an already-open tab only changes the fragment; start over so it gets used.
addEventListener("hashchange", () => location.hash.length > 1 && location.reload());
