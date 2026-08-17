import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createFileRoute("/back-redirect")({
  head: () => ({
    meta: [
      { title: "Back Redirect" },
      { name: "description", content: "Retention offer shown when leaving checkout." },
      { name: "robots", content: "noindex, follow" },
    ],
  }),
  component: BackRedirectRedirect,
});

function BackRedirectRedirect() {
  useEffect(() => {
    window.location.replace(`/back-redirect/index.html${window.location.search}${window.location.hash}`);
  }, []);

  return (
    <main className="grid min-h-dvh place-items-center bg-white px-5 text-center text-slate-950">
      <p className="text-sm font-bold">Loading...</p>
    </main>
  );
}
