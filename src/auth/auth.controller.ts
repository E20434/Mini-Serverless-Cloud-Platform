import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { AuthGuard } from './guards/auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  // Everything below requires an already-authenticated session (a JWT
  // from /auth/login) - you can't mint an API key without first proving
  // who you are some other way. Deliberately NOT scope-gated: creating,
  // listing, or revoking API keys is an account-management action for
  // the account owner themselves, not something a delegated,
  // scope-limited key should ever be doing to itself.
  @Post('api-keys')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.CREATED)
  createApiKey(@CurrentUser() user: { userId: string }, @Body() dto: CreateApiKeyDto) {
    return this.authService.createApiKey(user.userId, dto);
  }

  @Get('api-keys')
  @UseGuards(AuthGuard)
  listApiKeys(@CurrentUser() user: { userId: string }) {
    return this.authService.listApiKeys(user.userId);
  }

  @Delete('api-keys/:id')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  revokeApiKey(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.authService.revokeApiKey(user.userId, id);
  }
}
