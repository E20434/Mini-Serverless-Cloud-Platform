import crypto from 'node:crypto';
import { ConflictException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ALL_SCOPES, ApiScope } from './scopes';

const API_KEY_PREFIX = 'mc_';
// bcrypt's cost factor - how many times its internal hash round repeats.
// Higher = slower = more expensive to brute-force offline, at the cost
// of slower logins. 12 is a reasonable, common default in 2026.
const BCRYPT_ROUNDS = 12;

export interface AuthenticatedPrincipal {
  userId: string;
  scopes: readonly ApiScope[];
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<{ userId: string }> {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    try {
      const user = await this.prisma.user.create({
        data: { email: dto.email, passwordHash },
      });
      return { userId: user.id };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`An account with email "${dto.email}" already exists`);
      }
      throw err;
    }
  }

  async login(dto: LoginDto): Promise<{ accessToken: string }> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    // Deliberately the SAME error, same shape, whether the email doesn't
    // exist or the password is wrong - telling the two apart would let
    // an attacker enumerate which emails have accounts at all.
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }

    // A JWT-authenticated session represents the actual account owner,
    // not a delegated, scope-limited credential - it gets every scope
    // that exists. Scoping is specifically for API keys handed to
    // something else (a CI pipeline), not a restriction on yourself.
    const accessToken = this.jwt.sign({ sub: user.id, scopes: ALL_SCOPES });
    return { accessToken };
  }

  /**
   * Returns the RAW key exactly once - the caller must save it now. Only
   * its hash is ever persisted, matching the DTO comment from Part 4:
   * "never store the raw key, only a hash (like a password)." Unlike a
   * password hash, this uses plain SHA-256, not bcrypt - see the Phase 9
   * write-up for why: this hash is looked up on EVERY authenticated
   * request (an indexed `WHERE key_hash = ?`), where bcrypt's per-hash
   * salt would make indexed lookup impossible.
   */
  async createApiKey(userId: string, dto: CreateApiKeyDto) {
    const rawKey = `${API_KEY_PREFIX}${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = this.hashApiKey(rawKey);

    const record = await this.prisma.apiKey.create({
      data: { userId, name: dto.name, scopes: dto.scopes, keyHash },
    });

    return { id: record.id, name: record.name, scopes: record.scopes, rawKey };
  }

  listApiKeys(userId: string) {
    // Explicitly select everything EXCEPT keyHash - even to its own
    // owner, an API key's hash should never round-trip back out over
    // the API. There's no legitimate reason a client needs it, and
    // returning it would be handing back something meant to be a
    // one-way, write-only secret store.
    return this.prisma.apiKey.findMany({
      where: { userId },
      select: { id: true, name: true, scopes: true, lastUsedAt: true, revokedAt: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async revokeApiKey(userId: string, keyId: string): Promise<void> {
    const key = await this.prisma.apiKey.findUnique({ where: { id: keyId } });
    // Not found AND "found but belongs to someone else" both surface as
    // the same 404 - confirming a key ID exists at all, even one you
    // don't own, is itself a (minor) information leak worth avoiding.
    if (!key || key.userId !== userId) {
      throw new NotFoundException(`API key "${keyId}" not found`);
    }
    await this.prisma.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
  }

  /**
   * Used by ApiKeyStrategy (the guard) on every request presenting an API
   * key - never by anything else. Returns null for "not a valid,
   * unrevoked key," never throws, since an invalid credential on a
   * request is an expected, routine outcome for a guard to handle, not
   * an exceptional one.
   */
  async validateApiKey(rawKey: string): Promise<AuthenticatedPrincipal | null> {
    const keyHash = this.hashApiKey(rawKey);
    const record = await this.prisma.apiKey.findUnique({ where: { keyHash } });
    if (!record || record.revokedAt) {
      return null;
    }
    // Fire-and-forget - a slow or failed lastUsedAt update should never
    // block or fail the actual request this key is authenticating.
    this.prisma.apiKey.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
    return { userId: record.userId, scopes: record.scopes as ApiScope[] };
  }

  verifyJwt(token: string): AuthenticatedPrincipal {
    const payload = this.jwt.verify<{ sub: string; scopes: ApiScope[] }>(token);
    return { userId: payload.sub, scopes: payload.scopes };
  }

  private hashApiKey(rawKey: string): string {
    return crypto.createHash('sha256').update(rawKey).digest('hex');
  }
}
