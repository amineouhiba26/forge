import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'is_public';

/**
 * Marks a route as reachable without a token.
 *
 * The guard is applied globally, so authentication is the default and every
 * exception has to be written down explicitly. The reverse — opting routes
 * *into* protection — means a forgotten decorator silently publishes an
 * endpoint, and nothing fails to tell you.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
