import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { logs as otelLogs } from '@opentelemetry/api-logs';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SimpleLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

const OTEL_LOG_LEVEL = process.env.OTEL_LOG_LEVEL?.toLowerCase();

switch (OTEL_LOG_LEVEL) {
  case 'debug': {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
    break;
  }
  case 'info': {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
    break;
  }
  case 'warn': {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
    break;
  }
  case 'error': {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);
    break;
  }
  default: {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.NONE);
  }
}

function resolveDeploymentEnvironment(): string {
  switch (process.env.NODE_ENV) {
    case 'production': {
      return 'production';
    }
    case 'test': {
      return 'staging';
    }
    default: {
      return 'development';
    }
  }
}

const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'discord-dota',
  [ATTR_SERVICE_VERSION]: '1.0.0',
  [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: resolveDeploymentEnvironment(),
});

const traceExporter = new OTLPTraceExporter();
const metricExporter = new OTLPMetricExporter();
const logExporter = new OTLPLogExporter();

const loggerProvider = new LoggerProvider({
  resource,
  processors: [new SimpleLogRecordProcessor(logExporter)],
});
otelLogs.setGlobalLoggerProvider(loggerProvider);

const sdk = new NodeSDK({
  resource,
  traceExporter,
  metricReader: new PeriodicExportingMetricReader({
    exporter: metricExporter,
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-runtime-node': {
        enabled: false,
      },
    }),
  ],
});

sdk.start();

process.on('SIGTERM', () => {
  sdk
    .shutdown()
    .then(() => loggerProvider.shutdown())
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Error shutting down OpenTelemetry SDK', error);
      process.exit(1);
    });
});
