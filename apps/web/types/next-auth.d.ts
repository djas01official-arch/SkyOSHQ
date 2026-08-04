import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    activeOrganizationId: string | null;
    activeWorkspaceId: string | null;
    user: DefaultSession['user'] & {
      id: string;
    };
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    activeOrganizationId?: string | null;
    activeWorkspaceId?: string | null;
  }
}
