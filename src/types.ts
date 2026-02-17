// ---------------------------------------------------------------------------
// Tool Field types (discriminated union on `type`)
// ---------------------------------------------------------------------------

interface FieldBase {
  selector: string;
  name: string;
  description: string;
  required?: boolean;
  defaultValue?: string | number | boolean;
}

export interface TextField extends FieldBase {
  type: "text";
}

export interface NumberField extends FieldBase {
  type: "number";
}

export interface TextareaField extends FieldBase {
  type: "textarea";
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectField extends FieldBase {
  type: "select";
  options?: SelectOption[];
  dynamicOptions?: boolean;
}

export interface CheckboxField extends FieldBase {
  type: "checkbox";
}

export interface RadioOption {
  value: string;
  label: string;
  selector: string;
}

export interface RadioField extends FieldBase {
  type: "radio";
  options: RadioOption[];
}

export interface DateField extends FieldBase {
  type: "date";
}

export interface HiddenField extends FieldBase {
  type: "hidden";
}

export type ToolField =
  | TextField
  | NumberField
  | TextareaField
  | SelectField
  | CheckboxField
  | RadioField
  | DateField
  | HiddenField;

// ---------------------------------------------------------------------------
// Action Step types (discriminated union on `action`)
// ---------------------------------------------------------------------------

export interface NavigateStep {
  action: "navigate";
  url: string; // supports {{paramName}} templates
}

export interface ClickStep {
  action: "click";
  selector: string;
}

export interface FillStep {
  action: "fill";
  selector: string;
  value: string; // supports {{paramName}} templates
}

export interface SelectStep {
  action: "select";
  selector: string;
  value: string; // supports {{paramName}} templates
}

export interface WaitStep {
  action: "wait";
  selector: string;
  state?: "visible" | "exists" | "hidden";
  timeout?: number;
}

export interface ExtractStep {
  action: "extract";
  selector: string;
  extract: "text" | "html" | "list" | "table" | "attribute";
  attribute?: string;
}

export interface ScrollStep {
  action: "scroll";
  selector: string;
}

export interface ConditionStep {
  action: "condition";
  selector: string;
  state: "visible" | "exists" | "hidden";
  then: ActionStep[];
  else?: ActionStep[];
}

export type ActionStep =
  | NavigateStep
  | ClickStep
  | FillStep
  | SelectStep
  | WaitStep
  | ExtractStep
  | ScrollStep
  | ConditionStep;

// ---------------------------------------------------------------------------
// Execution Descriptor
// ---------------------------------------------------------------------------

export interface ExecutionDescriptor {
  selector: string;
  fields?: ToolField[];
  autosubmit: boolean;
  submitAction?: "click" | "enter";
  submitSelector?: string;
  resultSelector?: string;
  resultExtract?: "text" | "html" | "attribute" | "table" | "list";
  resultAttribute?: string;
  steps?: ActionStep[];
  resultDelay?: number;
  resultWaitSelector?: string;
}

// ---------------------------------------------------------------------------
// Tool & Config types
// ---------------------------------------------------------------------------

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, string>;
  execution?: ExecutionDescriptor;
}

export interface WebMcpConfig {
  id: string;
  domain: string;
  urlPattern: string;
  pageType?: string;
  title: string;
  description: string;
  tools: ToolDescriptor[];
  contributor: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
}
