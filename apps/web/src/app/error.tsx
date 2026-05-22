"use client";

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server logs get this via the Next.js runtime; this mirrors it
    // in the browser console for dev-loop visibility.
    console.error(error);
  }, [error]);

  return (
    <div style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>
        Something went wrong
      </h1>
      <pre
        style={{
          background: "#f4f4f5",
          padding: "1rem",
          borderRadius: "0.5rem",
          overflow: "auto",
          fontSize: "0.85rem",
        }}
      >
        {error.message}
        {error.digest ? `\n\ndigest: ${error.digest}` : null}
        {error.stack ? `\n\n${error.stack}` : null}
      </pre>
      <button
        onClick={reset}
        style={{
          marginTop: "1rem",
          padding: "0.5rem 1rem",
          border: "1px solid #d4d4d8",
          borderRadius: "0.375rem",
          background: "white",
          cursor: "pointer",
        }}
      >
        Try again
      </button>
    </div>
  );
}
