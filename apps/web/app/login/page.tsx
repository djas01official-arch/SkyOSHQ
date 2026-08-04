import { LoginForm } from '@/components/auth/login-form';

export const metadata = {
  title: 'Sign in',
};

export default function LoginPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-4">
      <section className="w-full max-w-md rounded-card border border-border bg-surface p-6 shadow-panel sm:p-8">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg bg-accent text-sm font-bold text-accent-foreground">
            S
          </span>
          <span className="text-lg font-semibold tracking-tight text-foreground">SkyOS</span>
        </div>
        <h1 className="mt-8 text-2xl font-semibold tracking-tight text-foreground">Sign in</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Use the configured development credentials to access the foundation environment.
        </p>
        <div className="mt-7">
          <LoginForm />
        </div>
      </section>
    </main>
  );
}
