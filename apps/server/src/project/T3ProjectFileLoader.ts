import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  LEGACY_T3_PROJECT_FILE_NAME,
  T3_PROJECT_FILE_NAME,
  type T3ProjectFile,
} from "@t3tools/contracts";
import { T3ProjectFileFromJson } from "@t3tools/shared/t3ProjectFile";

const decodeT3ProjectFileJson = Schema.decodeEffect(T3ProjectFileFromJson);

export class T3ProjectFileLoadError extends Schema.TaggedError<T3ProjectFileLoadError>()(
  "T3ProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${T3_PROJECT_FILE_NAME} at ${this.filePath}.`;
  }
}

export class T3ProjectFileLoader extends Context.Service<
  T3ProjectFileLoader,
  {
    /** Never fails; missing/unreadable/invalid files return none, with warnings for invalid files. */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<T3ProjectFile>>;
  }
>()("t3/project/T3ProjectFileLoader") {}

const logT3ProjectFileLoadError = (error: T3ProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: T3ProjectFileLoader["Service"]["load"] = Effect.fn("T3ProjectFileLoader.load")(
    function* (workspaceRoot) {
      const readCandidate = (fileName: string) => {
        const filePath = path.join(workspaceRoot, fileName);
        return fileSystem.readFileString(filePath).pipe(
          Effect.map((content) => Option.some({ content, filePath })),
          Effect.catchTags({
            PlatformError: (error) =>
              error.reason._tag === "NotFound"
                ? Effect.succeed(
                    Option.none<{ readonly content: string; readonly filePath: string }>(),
                  )
                : logT3ProjectFileLoadError(
                    new T3ProjectFileLoadError({
                      operation: "read",
                      workspaceRoot,
                      filePath,
                      cause: error,
                    }),
                  ).pipe(
                    Effect.as(
                      Option.none<{ readonly content: string; readonly filePath: string }>(),
                    ),
                  ),
          }),
        );
      };

      const loaded = Option.orElse(yield* readCandidate(T3_PROJECT_FILE_NAME), () =>
        Option.none<{ readonly content: string; readonly filePath: string }>(),
      );
      const resolved = Option.isSome(loaded)
        ? loaded
        : yield* readCandidate(LEGACY_T3_PROJECT_FILE_NAME);
      if (Option.isNone(resolved)) {
        return Option.none<T3ProjectFile>();
      }
      return yield* decodeT3ProjectFileJson(resolved.value.content).pipe(
        Effect.asSome,
        Effect.catchTags({
          SchemaError: (error) =>
            logT3ProjectFileLoadError(
              new T3ProjectFileLoadError({
                operation: "decode",
                workspaceRoot,
                filePath: resolved.value.filePath,
                cause: error,
              }),
            ).pipe(Effect.as(Option.none<T3ProjectFile>())),
        }),
      );
    },
  );

  return T3ProjectFileLoader.of({ load });
});

export const layer = Layer.effect(T3ProjectFileLoader, make);
