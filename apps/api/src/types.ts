import type { FastifyBaseLogger, FastifyInstance, RawReplyDefaultExpression, RawRequestDefaultExpression, RawServerDefault } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  FastifyBaseLogger,
  TypeBoxTypeProvider
>;
