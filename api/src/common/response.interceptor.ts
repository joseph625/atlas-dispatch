import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ApiEnvelope<T> {
  statusCode: number;
  message: string;
  data: T;
  meta?: unknown;
}

/**
 * Wraps successful responses in a consistent envelope. Handlers may return
 * `{ message, data, meta }` to customize, or any plain value (used as `data`).
 *
 * NOTE: unlike the shared template, this interceptor does NOT catch errors —
 * error shaping + status-code preservation is handled by AllExceptionsFilter,
 * so a 401/404/403 stays a 401/404/403 instead of collapsing to 500.
 */
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const res = context.switchToHttp().getResponse();
    return next.handle().pipe(
      map((payload) => {
        const statusCode = res.statusCode ?? 200;
        if (payload && typeof payload === 'object' && ('data' in payload || 'message' in payload)) {
          const p = payload as {
            message?: string;
            data?: unknown;
            meta?: unknown;
          };
          return {
            statusCode,
            message: p.message ?? 'Success',
            data: 'data' in p ? p.data : undefined,
            meta: p.meta,
          } satisfies ApiEnvelope<unknown>;
        }
        return {
          statusCode,
          message: 'Success',
          data: payload,
        } satisfies ApiEnvelope<unknown>;
      }),
    );
  }
}
