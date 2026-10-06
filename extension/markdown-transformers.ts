/**
 * pi keeps ONE markdown transformer per extension: registerMarkdownTransformer
 * assigns `extension.markdownTransformer = transformer` (loader.js), so a
 * second call silently replaces the first. Every module in this extension that
 * needs a transformer goes through addMarkdownTransformer, which registers a
 * single composed transformer per ExtensionAPI and runs the parts in order.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Transformer = Parameters<ExtensionAPI["registerMarkdownTransformer"]>[0];

const chains = new WeakMap<object, Transformer[]>();

export function addMarkdownTransformer(pi: ExtensionAPI, transformer: Transformer): void {
	let chain = chains.get(pi);
	if (!chain) {
		chain = [];
		chains.set(pi, chain);
	}
	chain.push(transformer);
	const parts = chain;
	pi.registerMarkdownTransformer((markdown, context) => {
		let out = markdown;
		for (const part of parts) out = part(out, context);
		return out;
	});
}
