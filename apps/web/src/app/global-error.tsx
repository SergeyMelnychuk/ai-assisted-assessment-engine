"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html>
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
        <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>
          Application error
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
      </body>
    </html>
  );
}
