import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

interface HttpErrorLike extends Error {
  status?: number;
  statusCode?: number;
}

function isHttpError(e: unknown): e is HttpErrorLike {
  return (
    e instanceof Error &&
    (typeof (e as HttpErrorLike).status === 'number' ||
      typeof (e as HttpErrorLike).statusCode === 'number')
  );
}

/**
 * Shapes every error into the same envelope as successful responses while
 * PRESERVING the real HTTP status code (HttpExceptions and http-errors keep
 * their status; anything else is a genuine 500).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let error = 'Error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const b = body as { message?: string | string[]; error?: string };
        message = b.message ?? exception.message;
        error = b.error ?? exception.name;
      }
    } else if (isHttpError(exception)) {
      // http-errors / express body-parser errors (e.g. PayloadTooLargeError = 413,
      // malformed JSON = 400) carry a numeric status but aren't Nest HttpExceptions.
      status = exception.status ?? exception.statusCode ?? status;
      message = exception.message;
      error = exception.name || 'Error';
    } else if (exception instanceof Error) {
      message = exception.message;
      error = exception.name;
      this.logger.error(exception.stack);
    }

    res.status(status).json({ statusCode: status, message, error, data: null });
  }
}
