import { Config, Option, Redacted } from "effect"

export const optionalConfig = <Value>(config: Config.Config<Value>) =>
  config.pipe(Config.option, Config.map(Option.getOrUndefined))

export const optionalBoolean = (name: string) => optionalConfig(Config.boolean(name))

export const optionalRedacted = (name: string) =>
  optionalConfig(Config.redacted(name)).pipe(
    Config.map((value) => (value && Redacted.value(value).trim().length > 0 ? value : undefined)),
  )

export const optionalString = (name: string) =>
  optionalConfig(Config.string(name)).pipe(
    Config.map((value) => (value && value.trim().length > 0 ? value : undefined)),
  )

export const requiredRedacted = (name: string) =>
  Config.redacted(name).pipe(
    Config.validate({
      message: `${name} must not be empty`,
      validation: (value) => Redacted.value(value).trim().length > 0,
    }),
  )

export const requiredString = (name: string) =>
  Config.string(name).pipe(
    Config.validate({
      message: `${name} must not be empty`,
      validation: (value) => value.trim().length > 0,
    }),
  )
