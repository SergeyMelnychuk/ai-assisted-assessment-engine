import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/server/db";
import { hashPassword } from "@/lib/password";

const registerSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  email: z.string().email("Valid email required"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(200),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        fieldErrors: parsed.error.flatten().fieldErrors,
      },
      { status: 400 },
    );
  }

  const { name, email, password } = parsed.data;
  const normalizedEmail = email.toLowerCase();

  try {
    const passwordHash = await hashPassword(password);
    const user = await db.user.create({
      data: {
        name,
        email: normalizedEmail,
        passwordHash,
        // Self-registration always produces an ASSESSOR. Admin promotion is
        // intentionally out-of-band (DB or an admin UI) to prevent privilege
        // escalation via the public register endpoint.
        role: "ASSESSOR",
      },
      select: { id: true, email: true, name: true, role: true },
    });
    return NextResponse.json({ user }, { status: 201 });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      // Don't leak "email already exists" — return the same generic message as
      // a successful signup would, or a 409. We pick 409 here because the
      // register form needs some signal to surface. Swap to generic if you
      // later add email enumeration as a concern.
      return NextResponse.json(
        { error: "An account with that email already exists" },
        { status: 409 },
      );
    }
    console.error("[register] unexpected error", err);
    return NextResponse.json(
      { error: "Could not create account" },
      { status: 500 },
    );
  }
}
