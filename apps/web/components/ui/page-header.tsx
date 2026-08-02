type PageHeaderProps = {
  description: string;
  eyebrow?: string;
  title: string;
};

export function PageHeader({ description, eyebrow, title }: PageHeaderProps) {
  return (
    <header className="mb-8">
      {eyebrow ? <p className="text-sm font-medium text-accent">{eyebrow}</p> : null}
      <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
        {title}
      </h1>
      <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">{description}</p>
    </header>
  );
}
