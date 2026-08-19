import { modulePlaceholders } from "../demo-data";

export async function getModulePlaceholder(name: string) { return modulePlaceholders.find(module => module.name === name) ?? null; }
