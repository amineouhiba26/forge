import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';

import {
  ClientDto,
  CreateClientRpcRequest,
  ListClientsRpcRequest,
  PaginatedResult,
  UpdateClientRpcRequest,
  buildPaginatedResult,
  toSkipTake,
} from '@forge/contracts';
import { PrismaService } from '@forge/prisma';

/**
 * Client CRUD.
 *
 * As in Sprint 1, queries carry no `where: { tenantId }` — `forTenant` sets the
 * Postgres tenant context and RLS applies the restriction. A redundant filter
 * would imply the isolation depends on remembering it.
 */
@Injectable()
export class ClientsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(request: CreateClientRpcRequest): Promise<ClientDto> {
    try {
      const client = await this.prisma.forTenant(request.tenantId, (tx) =>
        tx.client.create({
          data: {
            tenantId: request.tenantId,
            name: request.name,
            email: request.email.toLowerCase(),
            companyName: request.companyName ?? null,
          },
        }),
      );

      return toClientDto(client);
    } catch (error) {
      // P2002 is Prisma's unique-constraint violation. Translating it here
      // gives the caller an actionable 409 instead of a 500; letting it escape
      // would also leak the constraint name in the logs.
      if (isUniqueViolation(error)) {
        throw new RpcException({
          status: 409,
          message: 'A client with that email already exists',
        });
      }

      throw error;
    }
  }

  async list(
    request: ListClientsRpcRequest,
  ): Promise<PaginatedResult<ClientDto>> {
    const { skip, take } = toSkipTake(request);

    const where = {
      // `archivedAt: null` unless explicitly asked for. Note this is a
      // *business* filter, not a security one — RLS handles the tenant.
      ...(request.includeArchived ? {} : { archivedAt: null }),
      ...(request.search
        ? {
            OR: [
              {
                name: {
                  contains: request.search,
                  mode: 'insensitive' as const,
                },
              },
              {
                email: {
                  contains: request.search,
                  mode: 'insensitive' as const,
                },
              },
              {
                companyName: {
                  contains: request.search,
                  mode: 'insensitive' as const,
                },
              },
            ],
          }
        : {}),
    };

    const [clients, total] = await this.prisma.forTenant(
      request.tenantId,
      async (tx) =>
        // Both queries run inside one transaction, so the count cannot drift
        // from the page: a concurrent insert between two separate queries
        // would report a total that does not match what was returned.
        Promise.all([
          tx.client.findMany({
            where,
            skip,
            take,
            orderBy: { createdAt: 'desc' },
          }),
          tx.client.count({ where }),
        ]),
    );

    return buildPaginatedResult(clients.map(toClientDto), total, request);
  }

  async get(tenantId: string, clientId: string): Promise<ClientDto> {
    const client = await this.prisma.forTenant(tenantId, (tx) =>
      tx.client.findUnique({ where: { id: clientId } }),
    );

    // Another tenant's client is invisible to RLS, so this is indistinguishable
    // from one that does not exist — which is the point.
    if (!client) {
      throw new RpcException({ status: 404, message: 'Client not found' });
    }

    return toClientDto(client);
  }

  async update(request: UpdateClientRpcRequest): Promise<ClientDto> {
    await this.get(request.tenantId, request.clientId);

    try {
      const client = await this.prisma.forTenant(request.tenantId, (tx) =>
        tx.client.update({
          where: { id: request.clientId },
          data: {
            // Each field is applied only when present, so a PATCH omitting a
            // field leaves it alone rather than nulling it.
            ...(request.name !== undefined ? { name: request.name } : {}),
            ...(request.email !== undefined
              ? { email: request.email.toLowerCase() }
              : {}),
            ...(request.companyName !== undefined
              ? { companyName: request.companyName }
              : {}),
          },
        }),
      );

      return toClientDto(client);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RpcException({
          status: 409,
          message: 'A client with that email already exists',
        });
      }

      throw error;
    }
  }

  /**
   * Archives rather than deletes.
   *
   * A client referenced by contracts — and from Sprint 3 by issued invoices —
   * is part of the tenant's financial record. Deleting it would orphan
   * documents that must remain reproducible, which is also why the schema uses
   * `onDelete: Restrict` on the contract relation.
   */
  async archive(tenantId: string, clientId: string): Promise<ClientDto> {
    const existing = await this.get(tenantId, clientId);

    // Idempotent: archiving an already-archived client is not an error, and
    // re-stamping `archivedAt` would falsify when it actually happened.
    if (existing.archivedAt) {
      return existing;
    }

    const client = await this.prisma.forTenant(tenantId, (tx) =>
      tx.client.update({
        where: { id: clientId },
        data: { archivedAt: new Date() },
      }),
    );

    return toClientDto(client);
  }
}

interface ClientRow {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  companyName: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toClientDto(client: ClientRow): ClientDto {
  return {
    id: client.id,
    tenantId: client.tenantId,
    name: client.name,
    email: client.email,
    companyName: client.companyName,
    archivedAt: client.archivedAt?.toISOString() ?? null,
    createdAt: client.createdAt.toISOString(),
    updatedAt: client.updatedAt.toISOString(),
  };
}

/** Prisma signals a unique-constraint violation with code P2002. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}
