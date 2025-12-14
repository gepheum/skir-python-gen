import type {
  CodeGenerator,
  Constant,
  Method,
  Module,
  Record,
  RecordKey,
  RecordLocation,
  ResolvedType,
} from "skir-internal";
import { z } from "zod";
import { PY_UPPER_CAMEL_KEYWORDS, getClassName } from "./class_speller.js";
import { PyType } from "./py_type.js";
import { TypeSpeller } from "./type_speller.js";

const Config = z.object({});

type Config = z.infer<typeof Config>;

class PythonCodeGenerator implements CodeGenerator<Config> {
  readonly id = "python";
  readonly configType = Config;
  readonly version = "1.0.0";

  generateCode(input: CodeGenerator.Input<Config>): CodeGenerator.Output {
    const { recordMap, config } = input;
    const outputFiles: CodeGenerator.OutputFile[] = [];
    for (const module of input.modules) {
      outputFiles.push({
        path: module.path.replace(/\.skir$/, "_skir.py"),
        code: new PythonModuleCodeGenerator(
          module,
          recordMap,
          config,
        ).generate(),
      });
    }
    return { files: outputFiles };
  }
}

// Generates the code for one Python module.
class PythonModuleCodeGenerator {
  constructor(
    private readonly inModule: Module,
    recordMap: ReadonlyMap<RecordKey, RecordLocation>,
    private readonly config: Config,
  ) {
    this.typeSpeller = new TypeSpeller(recordMap, inModule);
  }

  generate(): string {
    // http://patorjk.com/software/taag/#f=Doom&t=Do%20not%20edit
    this.pushLine("#  ______                        _               _  _  _");
    this.pushLine("#  |  _  \\                      | |             | |(_)| |");
    this.pushLine("#  | | | |  ___    _ __    ___  | |_    ___   __| | _ | |_");
    this.pushLine(
      "#  | | | | / _ \\  | '_ \\  / _ \\ | __|  / _ \\ / _` || || __|",
    );
    this.pushLine(
      "#  | |/ / | (_) | | | | || (_) || |_  |  __/| (_| || || |_ ",
    );
    this.pushLine(
      "#  |___/   \\___/  |_| |_| \\___/  \\__|  \\___| \\__,_||_| \\__|",
    );
    this.pushLine("#");
    this.pushLine("# To install the Skir client library:");
    this.pushLine("#   pip install skir-client");
    this.pushLine();

    this.writeImports();

    this.writeClassesForRecords(
      this.inModule.records.filter(
        // Only retain top-level records.
        // Nested records will be processed from within their ancestors.
        (r: RecordLocation) => r.recordAncestors.length === 1,
      ),
    );

    for (const method of this.inModule.methods) {
      this.writeMethod(method);
    }

    for (const constant of this.inModule.constants) {
      this.writeConstant(constant);
    }

    this.writeInitModuleCall();

    return this.code;
  }

  private writeImports(): void {
    this.pushLine("import collections.abc");
    this.pushLine("import typing");
    this.pushLine();
    for (const path of Object.keys(this.inModule.pathToImportedNames)) {
      // We only need to import the modules, no  need to import the actual names.
      // We will refer to the imported symbols using the long notation:
      //    skirout.path.to.module_skir.Foo
      this.pushLine(
        `import skirout.${path.replace(/\.skir$/, "").replace("/", ".")}_skir`,
      );
    }
    this.pushLine("import skir");
    this.pushLine("from skir import _, _module_initializer, _spec");
  }

  private writeClassesForRecords(
    recordLocations: readonly RecordLocation[],
  ): void {
    const { recordMap } = this.typeSpeller;
    for (const record of recordLocations) {
      const { recordType } = record.record;
      this.pushLine();
      this.pushLine();
      if (recordType === "struct") {
        this.writeClassForStruct(record);
      } else {
        this.writeClassForEnum(record);
      }
      // Write the classes for the records nested in `record`.
      const nestedRecords = record.record.nestedRecords.map(
        (r) => recordMap.get(r.key)!,
      );
      this.writeClassesForRecords(nestedRecords);
      this.dedent();
    }
  }

  private writeClassForStruct(struct: RecordLocation): void {
    const { typeSpeller } = this;
    const { fields } = struct.record;
    const className = getClassName(struct, this.inModule);
    const { qualifiedName } = className;
    this.pushLine("@typing.final");
    this.pushLine(`class ${className.name}:`);
    this.pushLine("def __init__(");
    this.pushLine(" _self,");
    this.writeStructFieldsAsParams(struct.record, "initializer", "no-default");
    this.pushLine("): ...");
    this.pushLine();
    this.pushLine("@staticmethod");
    this.pushLine("def partial(");
    if (fields.length) {
      this.pushLine(" *,");
    }
    for (const field of fields) {
      const allRecordsFrozen = !!field.isRecursive;
      const pyType = typeSpeller.getPyType(
        field.type!,
        "initializer",
        allRecordsFrozen,
      );
      const attribute = structFieldToAttr(field.name.text);
      const defaultValue = getDefaultValue(field.type!);
      this.pushLine(` ${attribute}: ${pyType} = ${defaultValue},`);
    }
    this.pushLine(`) -> "${qualifiedName}": ...`);
    this.pushLine();
    this.pushLine("def replace(");
    this.pushLine(" _self,");
    this.writeStructFieldsAsParams(struct.record, "initializer", "keep");
    this.pushLine(`) -> "${qualifiedName}": ...`);
    for (const field of struct.record.fields) {
      const attribute = structFieldToAttr(field.name.text);
      const pyType = typeSpeller.getPyType(field.type!, "frozen");
      this.pushLine();
      this.pushLine("@property");
      this.pushLine(`def ${attribute}(self) -> ${pyType}: ...`);
    }
    this.pushLine();
    this.pushLine(`def to_frozen(self) -> "${qualifiedName}": ...`);
    this.pushLine(`def to_mutable(self) -> "${qualifiedName}.Mutable": ...`);
    this.pushLine();
    this.pushLine("@typing.final");
    this.pushLine("class Mutable:");
    this.pushLine("def __init__(");
    this.pushLine(" _self,");
    this.writeStructFieldsAsParams(struct.record, "maybe-mutable", "default");
    this.pushLine("): ...");
    this.pushLine();
    for (const field of struct.record.fields) {
      const allRecordsFrozen = !!field.isRecursive;
      const attribute = structFieldToAttr(field.name.text);
      const pyType = typeSpeller.getPyType(
        field.type!,
        "maybe-mutable",
        allRecordsFrozen,
      );
      this.pushLine(`${attribute}: ${pyType}`);
    }
    this.pushLine();
    for (const field of struct.record.fields) {
      const fieldType = field.type!;
      const { isRecursive } = field;
      const mutableType = typeSpeller.getPyType(fieldType, "mutable");
      const hasMutableGetter =
        typeSpeller
          .getPyType(fieldType, "maybe-mutable", !!isRecursive)
          .toString() !== mutableType.toString();
      if (!hasMutableGetter) continue;
      this.pushLine("@property");
      this.pushLine(
        `def mutable_${field.name.text}(self) -> ${mutableType}: ...`,
      );
      this.pushLine();
    }
    this.pushLine(`def to_frozen(self) -> "${qualifiedName}": ...`);
    this.dedent();
    this.pushLine();
    this.pushLine(
      `OrMutable: typing.TypeAlias = "${qualifiedName} | ${qualifiedName}.Mutable"`,
    );
    this.pushLine();
    this.pushLine(`DEFAULT: typing.Final["${qualifiedName}"] = _`);
    this.pushLine(
      `serializer: typing.Final[skir.Serializer["${qualifiedName}"]] = _`,
    );
  }

  private writeStructFieldsAsParams(
    struct: Record,
    flavor: "initializer" | "maybe-mutable",
    default_: "no-default" | "keep" | "default",
  ): void {
    const { typeSpeller } = this;
    const { fields } = struct;
    if (fields.length) {
      this.pushLine(" *,");
    }
    for (const field of fields) {
      const allRecordsFrozen = field.isRecursive;
      let pyType = typeSpeller.getPyType(
        field.type!,
        flavor,
        !!allRecordsFrozen,
      );
      if (default_ === "keep") {
        pyType = PyType.union([pyType, PyType.of("skir.Keep")]);
      }
      const attribute = structFieldToAttr(field.name.text);
      if (default_ === "no-default") {
        this.pushLine(` ${attribute}: ${pyType},`);
      } else if (default_ === "keep") {
        this.pushLine(` ${attribute}: ${pyType} = skir.KEEP,`);
      } else if (default_ === "default") {
        const defaultValue = getDefaultValue(field.type!);
        this.pushLine(` ${attribute}: ${pyType} = ${defaultValue},`);
      } else {
        const _: never = default_;
      }
    }
  }

  private writeClassForEnum(record: RecordLocation): void {
    const { typeSpeller } = this;
    const { fields: variants } = record.record;
    const constantVariants = variants.filter((v) => !v.type);
    const wrapperVariants = variants.filter((v) => v.type);
    const className = getClassName(record, this.inModule);
    const { qualifiedName } = className;
    this.pushLine("@typing.final");
    this.pushLine(`class ${className.name}:`);
    this.pushLine(`UNKNOWN: typing.Final["${qualifiedName}"] = _`);
    for (const constantVariant of constantVariants) {
      const attribute = enumWrapperVariantToAttr(constantVariant.name.text);
      this.pushLine(`${attribute}: typing.Final["${qualifiedName}"] = _`);
    }
    for (const wrapperVariant of wrapperVariants) {
      const name = wrapperVariant.name.text;
      const type = wrapperVariant.type!;
      const pyType = typeSpeller.getPyType(type, "initializer");
      this.pushLine();
      this.pushLine("@staticmethod");
      this.pushLine(
        `def wrap_${name}(value: ${pyType}) -> "${qualifiedName}": ...`,
      );
      if (type.kind === "record") {
        const { record } = typeSpeller.recordMap.get(type.key)!;
        if (record.recordType === "struct") {
          this.pushLine();
          this.pushLine("@staticmethod");
          this.pushLine(`def create_${name}(`);
          this.writeStructFieldsAsParams(record, "initializer", "no-default");
          this.pushLine(`) -> "${qualifiedName}": ...`);
        }
      }
    }
    this.pushLine();
    this.pushLine("def __init__(self, _: typing.NoReturn): ...");
    if (variants.length === 0) {
      return;
    }
    this.pushLine();
    {
      const kindTypeArgs = ['"?"']
        .concat(variants.map((v) => `"${v.name.text}"`))
        .join(", ");
      this.pushLine(`Kind: typing.TypeAlias = typing.Literal[${kindTypeArgs}]`);
    }
    {
      const kindType = PyType.quote(`${qualifiedName}.Kind`);
      this.pushLine();
      this.pushLine("@property");
      this.pushLine(`def kind(self) -> ${kindType}: ...`);
    }
    {
      const typesInUnion: PyType[] = wrapperVariants.map((f) =>
        typeSpeller.getPyType(f.type!, "frozen"),
      );
      typesInUnion.push(PyType.NONE);
      const valueType = PyType.union(typesInUnion);
      this.pushLine();
      this.pushLine("@property");
      this.pushLine(`def value(self) -> ${valueType}: ...`);
    }
    {
      const getVariantType = (name: string): PyType =>
        PyType.quote(`${qualifiedName}._${name}`);
      const typesInUnion = [getVariantType("Unknown")].concat(
        variants.map((v) => getVariantType(v.name.text)),
      );
      this.pushLine();
      this.pushLine("@property");
      this.pushLine(`def union(self) -> ${PyType.union(typesInUnion)}: ...`);
    }
    this.writeVariantClass("Unknown", PyType.NONE, "?");
    for (const variant of variants) {
      const variantName = variant.name.text;
      const valueType = variant.type
        ? typeSpeller.getPyType(variant.type, "frozen")
        : PyType.NONE;
      this.writeVariantClass(variantName, valueType);
    }
    this.pushLine();
    this.pushLine(
      `serializer: typing.Final[skir.Serializer["${qualifiedName}"]] = _`,
    );
  }

  private writeVariantClass(
    variantName: string,
    valueType: PyType,
    kind?: string,
  ): void {
    this.pushLine();
    this.pushLine(`class _${variantName}(typing.Protocol):`);
    this.pushLine("@property");
    this.pushLine(
      `def kind(self) -> typing.Literal["${kind || variantName}"]: ...`,
    );
    this.pushLine();
    this.pushLine("@property");
    this.pushLine(`def value(self) -> ${valueType}: ...`);
    this.dedent();
  }

  private writeMethod(method: Method): void {
    const { typeSpeller } = this;
    const methodName = method.name.text;
    const varName = PY_UPPER_CAMEL_KEYWORDS.has(methodName)
      ? `${methodName}_`
      : methodName;
    const requestType = typeSpeller.getPyType(method.requestType!, "frozen");
    const responseType = typeSpeller.getPyType(method.responseType!, "frozen");
    const methodType = `skir.Method[${requestType}, ${responseType}]`;
    this.pushLine();
    this.pushLine(`${varName}: typing.Final[${methodType}] = _`);
  }

  private writeConstant(constant: Constant): void {
    const { typeSpeller } = this;
    const name = constant.name.text;
    const type = typeSpeller.getPyType(constant.type!, "frozen");
    this.pushLine();
    this.pushLine(`${name}: typing.Final[${type}] = _`);
  }

  private writeInitModuleCall(): void {
    const { inModule, typeSpeller } = this;
    this.pushLine();
    this.pushLine();
    this.pushLine("_module_initializer.init_module(");
    this.pushLine(" records=(");
    for (const record of inModule.records) {
      const { doc: recordDoc, recordType, removedNumbers } = record.record;
      const className = getClassName(record, inModule);
      const recordQualname = record.recordAncestors
        .map((r) => r.name.text)
        .join(".");
      const recordId = `${inModule.path}:${recordQualname}`;
      if (recordType === "struct") {
        this.pushLine("  _spec.Struct(");
      } else {
        this.pushLine("  _spec.Enum(");
      }
      this.pushLine(`   id="${recordId}",`);
      if (className.name !== record.record.name.text) {
        this.pushLine(`   _class_name="${className.name}",`);
      }
      if (className.qualifiedName !== recordQualname) {
        this.pushLine(`   _class_qualname="${className.qualifiedName}",`);
      }
      if (recordDoc.text) {
        this.pushLine(`   doc=${JSON.stringify(recordDoc.text)},`);
      }
      if (removedNumbers.length) {
        const removedNumbersStr = removedNumbers
          .map((n) => `${n}, `)
          .join("")
          .trimEnd();
        this.pushLine(`   removed_numbers=(${removedNumbersStr}),`);
      }
      if (recordType === "struct") {
        const { fields } = record.record;
        this.pushLine(`   fields=(`);
        for (const field of fields) {
          const fieldName = field.name.text;
          const fieldType = field.type!;
          const { doc: fieldDoc, isRecursive } = field;
          const hasMutableGetter =
            typeSpeller
              .getPyType(fieldType, "mutable", !!isRecursive)
              .toString() !==
            typeSpeller
              .getPyType(fieldType, "maybe-mutable", !!isRecursive)
              .toString();
          this.pushLine("    _spec.Field(");
          this.pushLine(`     name="${fieldName}",`);
          this.pushLine(`     number=${field.number},`);
          this.pushLine(`     type=${this.typeToSpec(fieldType)},`);
          if (fieldDoc.text) {
            this.pushLine(`     doc=${JSON.stringify(fieldDoc.text)},`);
          }
          if (hasMutableGetter) {
            this.pushLine(`     has_mutable_getter=True,`);
          }
          const attribute = structFieldToAttr(fieldName);
          if (attribute !== fieldName) {
            this.pushLine(`     _attribute="${attribute}",`);
          }
          this.pushLine("    ),");
        }
        this.pushLine(`   ),`);
      } else {
        const { fields: variants } = record.record;
        const constantFields = variants.filter((f) => !f.type);
        const wrapperFields = variants.filter((f) => f.type);
        this.pushLine(`   constant_variants=(`);
        for (const variant of constantFields) {
          const variantName = variant.name.text;
          const { doc: variantDoc } = variant;
          this.pushLine("    _spec.ConstantVariant(");
          this.pushLine(`     name="${variantName}",`);
          this.pushLine(`     number=${variant.number},`);
          if (variantDoc.text) {
            this.pushLine(`     doc=${JSON.stringify(variantDoc.text)},`);
          }
          const attribute = enumWrapperVariantToAttr(variantName);
          if (attribute !== variantName) {
            this.pushLine(`     _attribute="${attribute}",`);
          }
          this.pushLine("    ),");
        }
        this.pushLine("   ),");
        this.pushLine("   wrapper_variants=(");
        for (const variant of wrapperFields) {
          this.pushLine("    _spec.WrapperVariant(");
          this.pushLine(`     name="${variant.name.text}",`);
          this.pushLine(`     number=${variant.number},`);
          this.pushLine(`     type=${this.typeToSpec(variant.type!)},`);
          this.pushLine("    ),");
        }
        this.pushLine("   ),");
      }
      this.pushLine("  ),");
    }
    this.pushLine(" ),");
    this.pushLine(" methods=(");
    for (const method of inModule.methods) {
      const methodName = method.name.text;
      const { doc } = method;
      this.pushLine("  _spec.Method(");
      this.pushLine(`   name="${methodName}",`);
      this.pushLine(`   number=${method.number},`);
      this.pushLine(`   request_type=${this.typeToSpec(method.requestType!)},`);
      this.pushLine(
        `   response_type=${this.typeToSpec(method.responseType!)},`,
      );
      if (doc.text) {
        this.pushLine(`   doc=${JSON.stringify(doc.text)},`);
      }
      if (PY_UPPER_CAMEL_KEYWORDS.has(methodName)) {
        this.pushLine(`   _var_name="${methodName}_",`);
      }
      this.pushLine("  ),");
    }
    this.pushLine(" ),");
    this.pushLine(" constants=(");
    for (const constant of inModule.constants) {
      const json_code = JSON.stringify(constant.valueAsDenseJson);
      this.pushLine("  _spec.Constant(");
      this.pushLine(`    name="${constant.name.text}",`);
      this.pushLine(`    type=${this.typeToSpec(constant.type!)},`);
      this.pushLine(`    json_code='${json_code.replace(/['\\]/g, "\\$&")}',`);
      this.pushLine("  ),");
    }
    this.pushLine(" ),");
    this.pushLine(" globals=globals(),");
    this.pushLine(")");
  }

  private typeToSpec(type: ResolvedType): string {
    switch (type.kind) {
      case "array": {
        const itemSpec = this.typeToSpec(type.item);
        let keyArg = "";
        if (type.key) {
          const attributes = type.key.path
            .map((n) => `"${structFieldToAttr(n.name.text)}", `)
            .join("")
            .trimEnd();
          keyArg = `, (${attributes})`;
        }
        return `_spec.ArrayType(${itemSpec}${keyArg})`;
      }
      case "optional": {
        const otherSpec = this.typeToSpec(type.other);
        return `_spec.OptionalType(${otherSpec})`;
      }
      case "primitive":
        return `_spec.PrimitiveType.${type.primitive.toUpperCase()}`;
      case "record": {
        const record = this.typeSpeller.recordMap.get(type.key)!;
        const { recordAncestors, modulePath } = record;
        const recordQualname = recordAncestors
          .map((r) => r.name.text)
          .join(".");
        return `"${modulePath}:${recordQualname}"`;
      }
    }
  }

  private pushLine(code = ""): void {
    if (code === "") {
      // An empty line.
      if (/\n\n$|:\n$/.test(this.code) && this.indent != "") {
        // Outside of the top level, coelesce empty lines.
        return;
      }
      this.code += "\n";
      return;
    }
    if (code.startsWith(" ")) {
      // Transform every leading space into 4 spaces.
      const numSpaces = code.length - code.trimStart().length;
      code = " ".repeat(3 * numSpaces) + code;
    }
    this.code += `${this.indent}${code}\n`;
    if (code.endsWith(":") && !code.startsWith("#")) {
      this.indent += "    ";
    }
  }

  private dedent(): void {
    this.indent = this.indent.substring(0, this.indent.length - 4);
  }

  private readonly typeSpeller: TypeSpeller;
  private code = "";
  private indent = "";
}

export const GENERATOR = new PythonCodeGenerator();

function structFieldToAttr(fieldName: string): string {
  return PY_LOWER_CASE_KEYWORDS.has(fieldName) ||
    STRUCT_GEN_LOWER_SYMBOLS.has(fieldName) ||
    fieldName.startsWith("mutable_")
    ? `${fieldName}_`
    : fieldName;
}

function enumWrapperVariantToAttr(variantName: string): string {
  return STRUCT_GEN_UPPER_SYMBOLS.has(variantName)
    ? `${variantName}_`
    : variantName;
}

function getDefaultValue(type: ResolvedType): string {
  switch (type.kind) {
    case "array":
      return type.key ? "_" : "()";
    case "optional":
      return "None";
    case "primitive": {
      switch (type.primitive) {
        case "bool":
          return "False";
        case "int32":
        case "int64":
        case "uint64":
          return "0";
        case "float32":
        case "float64":
          return "0.0";
        case "string":
          return '""';
        case "bytes":
          return 'b""';
        case "timestamp":
          return "skir.Timestamp.EPOCH";
      }
      const _: never = type.primitive;
      break;
    }
    case "record":
      return "_";
  }
}

/** Python keywords in lower_case format. */
const PY_LOWER_CASE_KEYWORDS: ReadonlySet<string> = new Set<string>([
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "import",
  "if",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

/** Name of lower_case formatted symbols generated in the Python class for a struct. */
const STRUCT_GEN_LOWER_SYMBOLS: ReadonlySet<string> = new Set<string>([
  "partial",
  "replace",
  "serializer",
  "to_frozen",
  "to_mutable",
]);

/** Name of UPPER_CASE formatted symbols generated in the Python class for an enum. */
const STRUCT_GEN_UPPER_SYMBOLS: ReadonlySet<string> = new Set<string>([
  "UNKNOWN",
]);
