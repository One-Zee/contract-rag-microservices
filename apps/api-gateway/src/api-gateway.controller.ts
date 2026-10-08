import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

@ApiTags('health')
// Docker polls this every few seconds; a throttled healthcheck would report
// a healthy gateway as down.
@SkipThrottle()
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ summary: 'Liveness probe' })
  check(): { status: string; service: string } {
    return { status: 'ok', service: 'api-gateway' };
  }
}
