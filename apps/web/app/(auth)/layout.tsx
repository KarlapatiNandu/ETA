export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col justify-center px-4 py-10">
      <p className="mb-6 text-center text-sm tracking-widest text-muted uppercase">Bus Mitra</p>
      {children}
    </main>
  );
}
