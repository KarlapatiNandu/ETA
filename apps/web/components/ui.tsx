import type { ComponentProps } from "react";

export function Card({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <section className="mx-auto w-full max-w-md rounded-2xl border border-line bg-panel p-6">
      {title && <h1 className="mb-4 text-xl font-semibold">{title}</h1>}
      {children}
    </section>
  );
}

export function Field({ label, ...props }: ComponentProps<"input"> & { label: string }) {
  return (
    <label className="mb-3 block text-sm">
      <span className="mb-1 block text-muted">{label}</span>
      <input
        {...props}
        className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-base outline-none focus:border-live"
      />
    </label>
  );
}

export function Button(props: ComponentProps<"button">) {
  return (
    <button
      {...props}
      className="w-full rounded-lg bg-live px-4 py-2.5 font-semibold text-black disabled:opacity-50"
    />
  );
}

export function ErrorText({ children }: { children?: string | null }) {
  return children ? (
    <p role="alert" className="mb-3 text-sm text-dark">
      {children}
    </p>
  ) : null;
}
