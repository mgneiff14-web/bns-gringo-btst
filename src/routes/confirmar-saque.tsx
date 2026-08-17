import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

export const Route = createFileRoute("/confirmar-saque")({
  component: CloneRoute,
});

const ENTRY_QS_KEY = "ttp_back_redirect_entry_qs";

type BackTrapState = { backtrap?: "root" | "guard" };

function CloneRoute() {
  const trapInstalled = useRef(false);

  useEffect(() => {
    if (!trapInstalled.current) {
      trapInstalled.current = true;

      try {
        if (!sessionStorage.getItem(ENTRY_QS_KEY)) {
          sessionStorage.setItem(ENTRY_QS_KEY, window.location.search || "");
        }
      } catch {
        /* sessionStorage unavailable */
      }

      history.replaceState(
        { backtrap: "root" },
        "",
        location.pathname + (location.search || "") + location.hash,
      );
      history.pushState({ backtrap: "guard" }, "");
    }

    function handlePopState(event: PopStateEvent) {
      const state = (event.state ?? history.state) as BackTrapState | null;
      if (!state || state.backtrap !== "root") return;

      let qs = location.search || "";
      try {
        qs = qs || sessionStorage.getItem(ENTRY_QS_KEY) || "";
      } catch {
        /* sessionStorage unavailable */
      }
      if (qs && qs[0] !== "?") qs = "?" + qs;

      location.replace("/back-redirect" + qs);
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  return null;
}
