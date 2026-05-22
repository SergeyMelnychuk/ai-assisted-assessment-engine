import Link from "next/link";

export default function NotFound() {
  return (
    <div style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>
        404 — Not found
      </h1>
      <p style={{ color: "#52525b", marginBottom: "1rem" }}>
        The page you&apos;re looking for doesn&apos;t exist.
      </p>
      <Link href="/" style={{ color: "#2563eb", textDecoration: "underline" }}>
        Back to home
      </Link>
    </div>
  );
}
