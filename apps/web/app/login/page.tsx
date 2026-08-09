import { LoginForm } from '@/components/auth/login-form';
import { Wordmark } from '@/components/brand/wordmark';

export const metadata = {
  title: 'Sign in',
};

export default function LoginPage() {
  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden bg-background p-4">
      <div aria-hidden="true" className="shell-grid pointer-events-none absolute inset-0" />
      <section className="surface-elevated relative w-full max-w-md rounded-panel p-6 sm:p-8">
        <div className="border-b border-border pb-6">
          <Wordmark showTagline />
        </div>
        <p className="mt-7 text-xs font-semibold uppercase tracking-[0.16em] text-brand-highlight">
          Secure access
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground">Sign in</h1>
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
