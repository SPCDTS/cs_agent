import { Type, type Static } from "typebox";
import { MEMORY_KINDS } from "./types";
const time = Type.Union([Type.Integer({minimum:0,maximum:253402300799}),Type.Null()]);
export const MemoryEditorSchema = Type.Object({
 text:Type.String({minLength:1,maxLength:500}), kind:Type.Enum(MEMORY_KINDS),
 subject:Type.Optional(Type.Union([Type.String({maxLength:40}),Type.Null()])),
 since:Type.Optional(time), until:Type.Optional(time), due_at:Type.Optional(time), done_at:Type.Optional(time),
},{additionalProperties:false});
export type MemoryEditor = Static<typeof MemoryEditorSchema>;
export const CandidateInputSchema = Type.Object({...MemoryEditorSchema.properties,
 evidence:Type.Optional(Type.Object({speaker:Type.String(),quote:Type.String({maxLength:500})},{additionalProperties:false})),
 author:Type.Literal("extractor"), confidence:Type.Number({minimum:0,maximum:1}),
 source_scope:Type.Union([Type.String(),Type.Null()]), source_message_id:Type.Union([Type.String(),Type.Null()]), source_turn_id:Type.String(),
},{additionalProperties:false});
export type MemoryCandidate = {id:number;ns:string;input_json:string;target_id:number;target_version:number;status:"pending"|"accepted"|"rejected";created_at:number};
