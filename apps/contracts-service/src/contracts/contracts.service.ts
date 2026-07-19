import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';

import {
  ContractDto,
  ContractStatusDto,
  CreateContractRpcRequest,
  ListContractsRpcRequest,
  MilestoneDto,
  MilestoneStatusDto,
  PaginatedResult,
  UpdateContractRpcRequest,
  buildPaginatedResult,
  toSkipTake,
} from '@forge/contracts';
import { PrismaService } from '@forge/prisma';

/**
 * Which status transitions are legal.
 *
 * Encoded as data rather than scattered `if` statements so the whole state
 * machine is readable at once. COMPLETED and CANCELLED are terminal: a
 * completed contract that could be dragged back to DRAFT would let its issued
 * invoices disagree with it.
 */
const ALLOWED_TRANSITIONS: Record<ContractStatusDto, ContractStatusDto[]> = {
  [ContractStatusDto.DRAFT]: [
    ContractStatusDto.ACTIVE,
    ContractStatusDto.CANCELLED,
  ],
  [ContractStatusDto.ACTIVE]: [
    ContractStatusDto.COMPLETED,
    ContractStatusDto.CANCELLED,
  ],
  [ContractStatusDto.COMPLETED]: [],
  [ContractStatusDto.CANCELLED]: [],
};

@Injectable()
export class ContractsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(request: CreateContractRpcRequest): Promise<ContractDto> {
    const contract = await this.prisma.forTenant(
      request.tenantId,
      async (tx) => {
        // The client is verified inside the same transaction, under the same
        // tenant context. A client belonging to another tenant is invisible
        // here, so this doubles as the cross-tenant check — you cannot attach
        // your contract to someone else's client.
        const client = await tx.client.findUnique({
          where: { id: request.clientId },
        });

        if (!client) {
          throw new RpcException({ status: 404, message: 'Client not found' });
        }

        if (client.archivedAt) {
          throw new RpcException({
            status: 409,
            message: 'Cannot create a contract for an archived client',
          });
        }

        return tx.contract.create({
          data: {
            tenantId: request.tenantId,
            clientId: request.clientId,
            title: request.title,
            description: request.description ?? null,
            currency: request.currency?.toUpperCase() ?? 'EUR',
            startDate: request.startDate ? new Date(request.startDate) : null,
            endDate: request.endDate ? new Date(request.endDate) : null,
            // Nested write: contract and milestones are created atomically.
            // Two separate calls could leave a contract with no milestones if
            // the second failed — a state the DTO forbids at the edge but the
            // database would happily hold.
            milestones: {
              create: request.milestones.map((milestone) => ({
                tenantId: request.tenantId,
                title: milestone.title,
                amount: milestone.amount,
                dueDate: new Date(milestone.dueDate),
              })),
            },
          },
          include: { milestones: { orderBy: { dueDate: 'asc' } } },
        });
      },
    );

    return toContractDto(contract);
  }

  async list(
    request: ListContractsRpcRequest,
  ): Promise<PaginatedResult<ContractDto>> {
    const { skip, take } = toSkipTake(request);

    const where = {
      ...(request.status ? { status: request.status } : {}),
      ...(request.clientId ? { clientId: request.clientId } : {}),
      ...(request.search
        ? { title: { contains: request.search, mode: 'insensitive' as const } }
        : {}),
    };

    const [contracts, total] = await this.prisma.forTenant(
      request.tenantId,
      async (tx) =>
        Promise.all([
          tx.contract.findMany({
            where,
            skip,
            take,
            orderBy: { createdAt: 'desc' },
            include: { milestones: { orderBy: { dueDate: 'asc' } } },
          }),
          tx.contract.count({ where }),
        ]),
    );

    return buildPaginatedResult(contracts.map(toContractDto), total, request);
  }

  async get(tenantId: string, contractId: string): Promise<ContractDto> {
    const contract = await this.prisma.forTenant(tenantId, (tx) =>
      tx.contract.findUnique({
        where: { id: contractId },
        include: { milestones: { orderBy: { dueDate: 'asc' } } },
      }),
    );

    if (!contract) {
      throw new RpcException({ status: 404, message: 'Contract not found' });
    }

    return toContractDto(contract);
  }

  async update(request: UpdateContractRpcRequest): Promise<ContractDto> {
    const existing = await this.get(request.tenantId, request.contractId);

    if (request.status && request.status !== existing.status) {
      this.assertTransitionAllowed(existing.status, request.status);
    }

    const contract = await this.prisma.forTenant(request.tenantId, (tx) =>
      tx.contract.update({
        where: { id: request.contractId },
        data: {
          ...(request.title !== undefined ? { title: request.title } : {}),
          ...(request.description !== undefined
            ? { description: request.description }
            : {}),
          ...(request.status !== undefined ? { status: request.status } : {}),
          ...(request.startDate !== undefined
            ? { startDate: new Date(request.startDate) }
            : {}),
          ...(request.endDate !== undefined
            ? { endDate: new Date(request.endDate) }
            : {}),
        },
        include: { milestones: { orderBy: { dueDate: 'asc' } } },
      }),
    );

    return toContractDto(contract);
  }

  async listMilestones(
    tenantId: string,
    contractId: string,
  ): Promise<MilestoneDto[]> {
    const contract = await this.get(tenantId, contractId);

    return contract.milestones;
  }

  /**
   * Marks a milestone complete — the event Sprint 3's invoice saga listens for.
   */
  async completeMilestone(
    tenantId: string,
    contractId: string,
    milestoneId: string,
  ): Promise<MilestoneDto> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const milestone = await tx.milestone.findUnique({
        where: { id: milestoneId },
        include: { contract: true },
      });

      // Checking the parent explicitly: without it, a milestone ID from a
      // *different contract in the same tenant* would be accepted, because RLS
      // only scopes to the tenant. Isolation between tenants is the database's
      // job; consistency within one is still ours.
      if (!milestone || milestone.contractId !== contractId) {
        throw new RpcException({ status: 404, message: 'Milestone not found' });
      }

      if (milestone.status === 'COMPLETE') {
        throw new RpcException({
          status: 409,
          message: 'Milestone is already complete',
        });
      }

      if (milestone.contract.status !== 'ACTIVE') {
        throw new RpcException({
          status: 409,
          message: `Cannot complete a milestone on a ${milestone.contract.status.toLowerCase()} contract`,
        });
      }

      const updated = await tx.milestone.update({
        where: { id: milestoneId },
        data: { status: 'COMPLETE', completedAt: new Date() },
      });

      return toMilestoneDto(updated);
    });
  }

  private assertTransitionAllowed(
    from: ContractStatusDto,
    to: ContractStatusDto,
  ): void {
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
      throw new RpcException({
        status: 409,
        message: `Cannot move a contract from ${from} to ${to}`,
      });
    }
  }
}

interface MilestoneRow {
  id: string;
  contractId: string;
  title: string;
  amount: { toFixed(decimalPlaces: number): string };
  dueDate: Date;
  status: string;
  completedAt: Date | null;
}

interface ContractRow {
  id: string;
  tenantId: string;
  clientId: string;
  title: string;
  description: string | null;
  status: string;
  currency: string;
  startDate: Date | null;
  endDate: Date | null;
  milestones: MilestoneRow[];
  createdAt: Date;
  updatedAt: Date;
}

function toMilestoneDto(milestone: MilestoneRow): MilestoneDto {
  return {
    id: milestone.id,
    contractId: milestone.contractId,
    title: milestone.title,
    // Serialised as a string on purpose. JSON numbers are IEEE 754 doubles,
    // so a Decimal round-trips through JSON.parse with precision loss — the
    // exact problem Decimal was chosen to avoid.
    //
    // `toFixed(2)` rather than `toString()`: the latter renders 2500.50 as
    // "2500.5", so the same stored amount would serialise differently
    // depending on its value. Money should always carry its minor units.
    amount: milestone.amount.toFixed(2),
    dueDate: milestone.dueDate.toISOString(),
    status: milestone.status as MilestoneStatusDto,
    completedAt: milestone.completedAt?.toISOString() ?? null,
  };
}

function toContractDto(contract: ContractRow): ContractDto {
  return {
    id: contract.id,
    tenantId: contract.tenantId,
    clientId: contract.clientId,
    title: contract.title,
    description: contract.description,
    status: contract.status as ContractStatusDto,
    currency: contract.currency,
    startDate: contract.startDate?.toISOString() ?? null,
    endDate: contract.endDate?.toISOString() ?? null,
    milestones: contract.milestones.map(toMilestoneDto),
    createdAt: contract.createdAt.toISOString(),
    updatedAt: contract.updatedAt.toISOString(),
  };
}
