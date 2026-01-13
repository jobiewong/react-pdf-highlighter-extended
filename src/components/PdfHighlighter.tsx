import "pdfjs-dist/web/pdf_viewer.css";
import "../style/PdfHighlighter.css";
import "../style/pdf_viewer.css";

import debounce from "lodash.debounce";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type {
	EventBus as TEventBus,
	PDFFindController as TPDFFindController,
	PDFLinkService as TPDFLinkService,
	PDFViewer as TPDFViewer,
} from "pdfjs-dist/web/pdf_viewer.mjs";
import React, {
	type CSSProperties,
	type PointerEventHandler,
	type ReactNode,
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
	PdfHighlighterContext,
	type PdfHighlighterUtils,
} from "../contexts/PdfHighlighterContext";
import { scaledToViewport, viewportPositionToScaled } from "../lib/coordinates";
import getBoundingRect from "../lib/get-bounding-rect";
import getClientRects from "../lib/get-client-rects";
import groupHighlightsByPage from "../lib/group-highlights-by-page";
import {
	asElement,
	findOrCreateContainerLayer,
	getPagesFromRange,
	getWindow,
	isHTMLElement,
} from "../lib/pdfjs-dom";
import type {
	Content,
	GhostHighlight,
	Highlight,
	HighlightBindings,
	PdfScaleValue,
	PdfSelection,
	Tip,
	ViewportPosition,
} from "../types";
import { HighlightLayer } from "./HighlightLayer";
import { MouseSelection } from "./MouseSelection";
import { TipContainer } from "./TipContainer";

let EventBus: typeof TEventBus,
	PDFFindController: typeof TPDFFindController,
	PDFLinkService: typeof TPDFLinkService,
	PDFViewer: typeof TPDFViewer;

(async () => {
	// Due to breaking changes in PDF.js 4.0.189. See issue #17228
	const pdfjs = await import("pdfjs-dist/web/pdf_viewer.mjs");
	EventBus = pdfjs.EventBus;
	PDFFindController = pdfjs.PDFFindController;
	PDFLinkService = pdfjs.PDFLinkService;
	PDFViewer = pdfjs.PDFViewer;
})();

const SCROLL_MARGIN = 10;
const DEFAULT_SCALE_VALUE = "auto";
const DEFAULT_TEXT_SELECTION_COLOR = "rgba(153,193,218,255)";

const findOrCreateHighlightLayer = (textLayer: HTMLElement) => {
	return findOrCreateContainerLayer(
		textLayer,
		"PdfHighlighter__highlight-layer",
	);
};

const disableTextSelection = (
	viewer: InstanceType<typeof PDFViewer>,
	flag: boolean,
) => {
	viewer.viewer?.classList.toggle("PdfHighlighter--disable-selection", flag);
};

/**
 * The props type for {@link PdfHighlighter}.
 *
 * @category Component Properties
 */
export interface PdfHighlighterProps {
	/**
	 * Array of all highlights to be organised and fed through to the child
	 * highlight container.
	 */
	highlights: Array<Highlight>;

	/**
	 * Event is called only once whenever the user changes scroll after
	 * the autoscroll function, scrollToHighlight, has been called.
	 */
	onScrollAway?(): void;

	/**
	 * What scale to render the PDF at inside the viewer.
	 */
	pdfScaleValue?: PdfScaleValue;

	/**
	 * Callback triggered whenever a user finishes making a mouse selection or has
	 * selected text.
	 *
	 * @param PdfSelection - Content and positioning of the selection. NOTE:
	 * `makeGhostHighlight` will not work if the selection disappears.
	 */
	onSelection?(PdfSelection: PdfSelection): void;

	/**
	 * Callback triggered whenever a ghost (non-permanent) highlight is created.
	 *
	 * @param ghostHighlight - Ghost Highlight that has been created.
	 */
	onCreateGhostHighlight?(ghostHighlight: GhostHighlight): void;

	/**
	 * Callback triggered whenever a ghost (non-permanent) highlight is removed.
	 *
	 * @param ghostHighlight - Ghost Highlight that has been removed.
	 */
	onRemoveGhostHighlight?(ghostHighlight: GhostHighlight): void;

	/**
	 * Optional element that can be displayed as a tip whenever a user makes a
	 * selection.
	 */
	selectionTip?: ReactNode;

	/**
	 * Condition to check before any mouse selection starts.
	 *
	 * @param event - mouse event associated with the new selection.
	 * @returns - `True` if mouse selection should start.
	 */
	enableAreaSelection?(event: MouseEvent): boolean;

	/**
	 * Optional CSS styling for the rectangular mouse selection.
	 */
	mouseSelectionStyle?: CSSProperties;

	/**
	 * PDF document to view and overlay highlights.
	 */
	pdfDocument: PDFDocumentProxy;

	/**
	 * This should be a highlight container/renderer of some sorts. It will be
	 * given appropriate context for a single highlight which it can then use to
	 * render a TextHighlight, AreaHighlight, etc. in the correct place.
	 */
	children: ReactNode;

	/**
	 * Coloring for unhighlighted, selected text.
	 */
	textSelectionColor?: string;

	/**
	 * Creates a reference to the PdfHighlighterContext above the component.
	 *
	 * @param pdfHighlighterUtils - various useful tools with a PdfHighlighter.
	 * See {@link PdfHighlighterContext} for more description.
	 */
	utilsRef(pdfHighlighterUtils: PdfHighlighterUtils): void;

	/**
	 * Callback triggered when the PDF viewer is ready and initialized.
	 *
	 * @param viewer - The initialized PDF viewer instance.
	 */
	onViewerReady?(viewer: InstanceType<typeof PDFViewer>): void;

	/**
	 * Callback triggered whenever the current page changes.
	 *
	 * @param pageNumber - The new current page number (1-indexed).
	 */
	onPageChange?(pageNumber: number): void;

	/**
	 * Style properties for the PdfHighlighter (scrollbar, background, etc.), NOT
	 * the PDF.js viewer it encloses. If you want to edit the latter, use the
	 * other style props like `textSelectionColor` or overwrite pdf_viewer.css
	 */
	style?: CSSProperties;
}

/**
 * This is a large-scale PDF viewer component designed to facilitate
 * highlighting. It should be used as a child to a {@link PdfLoader} to ensure
 * proper document loading. This does not itself render any highlights, but
 * instead its child should be the container component for each individual
 * highlight. This component will be provided appropriate HighlightContext for
 * rendering.
 *
 * @category Component
 */
export const PdfHighlighter = ({
	highlights,
	onScrollAway,
	pdfScaleValue = DEFAULT_SCALE_VALUE,
	onSelection: onSelectionFinished,
	onCreateGhostHighlight,
	onRemoveGhostHighlight,
	selectionTip,
	enableAreaSelection,
	mouseSelectionStyle,
	pdfDocument,
	children,
	textSelectionColor = DEFAULT_TEXT_SELECTION_COLOR,
	utilsRef,
	onViewerReady,
	onPageChange,
	style,
}: PdfHighlighterProps) => {
	// State
	const [tip, setTip] = useState<Tip | null>(null);
	const [isViewerReady, setIsViewerReady] = useState(false);
	const [currentPage, setCurrentPage] = useState<number>(1);

	// Refs
	const containerNodeRef = useRef<HTMLDivElement | null>(null);
	const highlightBindingsRef = useRef<{ [page: number]: HighlightBindings }>(
		{},
	);
	const ghostHighlightRef = useRef<GhostHighlight | null>(null);
	const selectionRef = useRef<PdfSelection | null>(null);
	const scrolledToHighlightIdRef = useRef<string | null>(null);
	const isAreaSelectionInProgressRef = useRef(false);
	const isEditInProgressRef = useRef(false);
	const updateTipPositionRef = useRef(() => {});
	const previousPageRef = useRef<number>(1);

	const eventBusRef = useRef<InstanceType<typeof EventBus>>(new EventBus());
	const linkServiceRef = useRef<InstanceType<typeof PDFLinkService>>(
		new PDFLinkService({
			eventBus: eventBusRef.current,
			externalLinkTarget: 2,
		}),
	);
	const resizeObserverRef = useRef<ResizeObserver | null>(null);
	const viewerRef = useRef<InstanceType<typeof PDFViewer> | null>(null);
	const findControllerRef = useRef<InstanceType<typeof PDFFindController> | null>(
		null,
	);

	// Initialise PDF Viewer
	useLayoutEffect(() => {
		if (!containerNodeRef.current) return;

		const debouncedDocumentInit = debounce(() => {
			viewerRef.current =
				viewerRef.current ||
				new PDFViewer({
					container: containerNodeRef.current!,
					eventBus: eventBusRef.current,
					textLayerMode: 2,
					removePageBorders: true,
					linkService: linkServiceRef.current,
				});

			// Initialize find controller
			findControllerRef.current =
				findControllerRef.current ||
				new PDFFindController({
					eventBus: eventBusRef.current,
					linkService: linkServiceRef.current,
				});

			viewerRef.current.setDocument(pdfDocument);
			linkServiceRef.current.setDocument(pdfDocument);
			linkServiceRef.current.setViewer(viewerRef.current);
			findControllerRef.current.setDocument(pdfDocument);
			setIsViewerReady(true);

			// Initialize current page from viewer (may not be available immediately)
			// The pagechanged event will update it once the viewer is ready
			if (viewerRef.current.currentPageNumber) {
				const initialPage = viewerRef.current.currentPageNumber;
				setCurrentPage(initialPage);
				onPageChange?.(initialPage);
			}

			onViewerReady?.(viewerRef.current);
		}, 100);

		debouncedDocumentInit();

		return () => {
			debouncedDocumentInit.cancel();
		};
	}, [pdfDocument, onViewerReady, onPageChange]);

	// Track page changes on scroll
	const checkPageChange = useCallback(() => {
		if (!viewerRef.current) return;

		const newPage = viewerRef.current.currentPageNumber;
		if (newPage && newPage !== previousPageRef.current) {
			previousPageRef.current = newPage;
			setCurrentPage(newPage);
			onPageChange?.(newPage);
		}
	}, [onPageChange]);

	// Initialise viewer event listeners
	useLayoutEffect(() => {
		if (!containerNodeRef.current || !viewerRef.current) return;

		const debouncedScaleValue = debounce(handleScaleValue, 100);
		resizeObserverRef.current = new ResizeObserver(debouncedScaleValue);
		resizeObserverRef.current.observe(containerNodeRef.current);

		const doc = containerNodeRef.current.ownerDocument;

		const handleUpdateViewArea = () => {
			// Check for page changes when view area updates
			checkPageChange();
		};

		const handlePagesInit = () => {
			handleScaleValue();
			// Initialize current page when pages are initialized
			if (viewerRef.current?.currentPageNumber) {
				const initialPage = viewerRef.current.currentPageNumber;
				previousPageRef.current = initialPage;
				setCurrentPage(initialPage);
				onPageChange?.(initialPage);
			}
		};

		// Listen to scroll events to track page changes
		const container = viewerRef.current.container;
		const debouncedPageCheck = debounce(checkPageChange, 100);
		container.addEventListener("scroll", debouncedPageCheck);

		eventBusRef.current.on("textlayerrendered", renderHighlightLayers);
		eventBusRef.current.on("pagesinit", handlePagesInit);
		eventBusRef.current.on("updateviewarea", handleUpdateViewArea);
		doc.addEventListener("keydown", handleKeyDown);

		renderHighlightLayers();

		return () => {
			container.removeEventListener("scroll", debouncedPageCheck);
			eventBusRef.current.off("pagesinit", handlePagesInit);
			eventBusRef.current.off("textlayerrendered", renderHighlightLayers);
			eventBusRef.current.off("updateviewarea", handleUpdateViewArea);
			doc.removeEventListener("keydown", handleKeyDown);
			resizeObserverRef.current?.disconnect();
			debouncedScaleValue.cancel();
			debouncedPageCheck.cancel();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		selectionTip,
		highlights,
		onSelectionFinished,
		onPageChange,
		checkPageChange,
	]);

	// Event listeners
	const handleScroll = () => {
		onScrollAway && onScrollAway();
		scrolledToHighlightIdRef.current = null;
		checkPageChange();
		renderHighlightLayers();
	};

	const handleMouseUp: PointerEventHandler = () => {
		const container = containerNodeRef.current;
		const selection = getWindow(container).getSelection();

		if (!container || !selection || selection.isCollapsed || !viewerRef.current)
			return;

		const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

		// Check the selected text is in the document, not the tip
		if (!range || !container.contains(range.commonAncestorContainer)) return;

		const pages = getPagesFromRange(range);
		if (!pages || pages.length === 0) return;

		const rects = getClientRects(range, pages);
		if (rects.length === 0) return;

		const viewportPosition: ViewportPosition = {
			boundingRect: getBoundingRect(rects),
			rects,
		};

		const scaledPosition = viewportPositionToScaled(
			viewportPosition,
			viewerRef.current,
		);

		const content: Content = {
			text: selection.toString().split("\n").join(" "), // Make all line breaks spaces
		};

		selectionRef.current = {
			content,
			type: "text",
			position: scaledPosition,
			makeGhostHighlight: () => {
				ghostHighlightRef.current = {
					content: content,
					type: "text",
					position: scaledPosition,
				};

				onCreateGhostHighlight &&
					onCreateGhostHighlight(ghostHighlightRef.current);
				clearTextSelection();
				renderHighlightLayers();
				return ghostHighlightRef.current;
			},
		};

		onSelectionFinished && onSelectionFinished(selectionRef.current);

		selectionTip &&
			setTip({ position: viewportPosition, content: selectionTip });
	};

	const handleMouseDown: PointerEventHandler = (event) => {
		if (
			!isHTMLElement(event.target) ||
			asElement(event.target).closest(".PdfHighlighter__tip-container") // Ignore selections on tip container
		) {
			return;
		}

		setTip(null);
		clearTextSelection(); // TODO: Check if clearing text selection only if not clicking on tip breaks anything.
		removeGhostHighlight();
		toggleEditInProgress(false);
	};

	const handleKeyDown = (event: KeyboardEvent) => {
		if (event.code === "Escape") {
			clearTextSelection();
			removeGhostHighlight();
			setTip(null);
		}
	};

	const handleScaleValue = () => {
		if (!viewerRef.current || !viewerRef.current.currentScaleValue) return;

		try {
			const scaleValue = pdfScaleValue.toString();
			if (scaleValue === "auto") {
				viewerRef.current.currentScaleValue = "auto";
			} else {
				const numericScale = parseFloat(scaleValue);
				if (!isNaN(numericScale)) {
					// Ensure the scale value is within valid range (0.1 to 10.0)
					const validScale = Math.min(Math.max(numericScale, 0.1), 10.0);
					viewerRef.current.currentScaleValue = validScale.toString();
				}
			}
		} catch (error) {
			console.warn("Error setting PDF scale value:", error);
		}
	};

	// Render Highlight layers
	const renderHighlightLayer = (
		highlightBindings: HighlightBindings,
		pageNumber: number,
	) => {
		if (!viewerRef.current) return;

		highlightBindings.reactRoot.render(
			<PdfHighlighterContext.Provider value={pdfHighlighterUtils}>
				<HighlightLayer
					highlightsByPage={groupHighlightsByPage([
						...highlights,
						ghostHighlightRef.current,
					])}
					pageNumber={pageNumber}
					scrolledToHighlightId={scrolledToHighlightIdRef.current}
					viewer={viewerRef.current}
					highlightBindings={highlightBindings}
					children={children}
				/>
			</PdfHighlighterContext.Provider>,
		);
	};

	const renderHighlightLayers = () => {
		if (!viewerRef.current) return;

		for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
			const highlightBindings = highlightBindingsRef.current[pageNumber];

			// Need to check if container is still attached to the DOM as PDF.js can unload pages.
			if (highlightBindings?.container?.isConnected) {
				renderHighlightLayer(highlightBindings, pageNumber);
			} else {
				const { textLayer } =
					viewerRef.current!.getPageView(pageNumber - 1) || {};
				if (!textLayer) continue; // Viewer hasn't rendered page yet

				// textLayer.div for version >=3.0 and textLayer.textLayerDiv otherwise.
				const highlightLayer = findOrCreateHighlightLayer(textLayer.div);

				if (highlightLayer) {
					const reactRoot = createRoot(highlightLayer);
					highlightBindingsRef.current[pageNumber] = {
						reactRoot,
						container: highlightLayer,
						textLayer: textLayer.div, // textLayer.div for version >=3.0 and textLayer.textLayerDiv otherwise.
					};

					renderHighlightLayer(
						highlightBindingsRef.current[pageNumber],
						pageNumber,
					);
				}
			}
		}
	};

	// Utils
	const isEditingOrHighlighting = () => {
		return (
			Boolean(selectionRef.current) ||
			Boolean(ghostHighlightRef.current) ||
			isAreaSelectionInProgressRef.current ||
			isEditInProgressRef.current
		);
	};

	const toggleEditInProgress = (flag?: boolean) => {
		if (flag !== undefined) {
			isEditInProgressRef.current = flag;
		} else {
			isEditInProgressRef.current = !isEditInProgressRef.current;
		}

		// Disable text selection
		if (viewerRef.current)
			viewerRef.current.viewer?.classList.toggle(
				"PdfHighlighter--disable-selection",
				isEditInProgressRef.current,
			);
	};

	const removeGhostHighlight = () => {
		if (onRemoveGhostHighlight && ghostHighlightRef.current)
			onRemoveGhostHighlight(ghostHighlightRef.current);
		ghostHighlightRef.current = null;
		renderHighlightLayers();
	};

	const clearTextSelection = () => {
		selectionRef.current = null;

		const container = containerNodeRef.current;
		const selection = getWindow(container).getSelection();
		if (!container || !selection) return;
		selection.removeAllRanges();
	};

	const scrollToHighlight = (highlight: Highlight, paddingTop?: number) => {
		const { boundingRect, usePdfCoordinates } = highlight.position;
		const pageNumber = Number(boundingRect.pageNumber);

		// Validate page number
		if (
			isNaN(pageNumber) ||
			pageNumber < 1 ||
			pageNumber > pdfDocument.numPages
		) {
			console.warn(`Invalid page number: ${boundingRect.pageNumber}`);
			return;
		}

		// Remove scroll listener in case user auto-scrolls in succession.
		viewerRef.current!.container.removeEventListener("scroll", handleScroll);

		const pageViewport = viewerRef.current!.getPageView(
			pageNumber - 1,
		).viewport;

		// Get the page element
		const pageElement = viewerRef.current!.getPageView(pageNumber - 1).div;

		// Calculate the target scroll position
		const scaledPosition = scaledToViewport(
			boundingRect,
			pageViewport,
			usePdfCoordinates,
		);
		const targetScrollTop =
			pageElement.offsetTop +
			scaledPosition.top -
			SCROLL_MARGIN +
			(paddingTop ?? 0);

		// Use smooth scrolling
		viewerRef.current!.container.scrollTo({
			top: targetScrollTop,
			behavior: "smooth",
		});

		scrolledToHighlightIdRef.current = highlight.id;
		renderHighlightLayers();

		// wait for scrolling to finish
		setTimeout(() => {
			viewerRef.current!.container.addEventListener("scroll", handleScroll, {
				once: true,
			});
		}, 100);
	};

	const goToPage = (pageNumber: number) => {
		if (!viewerRef.current || !linkServiceRef.current) {
			console.warn("PDF viewer is not ready");
			return;
		}

		// Validate page number is within bounds
		if (
			isNaN(pageNumber) ||
			pageNumber < 1 ||
			pageNumber > pdfDocument.numPages
		) {
			console.warn(
				`Invalid page number: ${pageNumber}. Must be between 1 and ${pdfDocument.numPages}`,
			);
			return;
		}

		// Use PDF.js linkService to navigate (this is the recommended way)
		linkServiceRef.current.goToPage(pageNumber);
	};

	const searchText = (
		query: string,
		options?: {
			caseSensitive?: boolean;
			entireWord?: boolean;
			highlightAll?: boolean;
			findPrevious?: boolean;
		},
	) => {
		if (!findControllerRef.current) {
			console.warn("PDF find controller is not ready");
			return;
		}

		if (!query.trim()) {
			clearSearch();
			return;
		}

		const {
			caseSensitive = false,
			entireWord = false,
			highlightAll = true,
			findPrevious = false,
		} = options || {};

		findControllerRef.current.executeCommand("find", {
			query,
			caseSensitive,
			entireWord,
			highlightAll,
			findPrevious,
		});
	};

	const findNext = () => {
		if (!findControllerRef.current) {
			console.warn("PDF find controller is not ready");
			return;
		}

		const state = findControllerRef.current.state;
		if (!state.query) {
			console.warn("No active search query");
			return;
		}

		findControllerRef.current.executeCommand("findagain", {
			query: state.query,
			caseSensitive: state.caseSensitive,
			entireWord: state.entireWord,
			highlightAll: state.highlightAll,
			findPrevious: false,
		});
	};

	const findPrevious = () => {
		if (!findControllerRef.current) {
			console.warn("PDF find controller is not ready");
			return;
		}

		const state = findControllerRef.current.state;
		if (!state.query) {
			console.warn("No active search query");
			return;
		}

		findControllerRef.current.executeCommand("findagain", {
			query: state.query,
			caseSensitive: state.caseSensitive,
			entireWord: state.entireWord,
			highlightAll: state.highlightAll,
			findPrevious: true,
		});
	};

	const clearSearch = () => {
		if (!findControllerRef.current) {
			return;
		}

		findControllerRef.current.executeCommand("find", {
			query: "",
			highlightAll: false,
		});
	};

	const pdfHighlighterUtils: PdfHighlighterUtils = {
		isEditingOrHighlighting,
		getCurrentSelection: () => selectionRef.current,
		getGhostHighlight: () => ghostHighlightRef.current,
		removeGhostHighlight,
		toggleEditInProgress,
		isEditInProgress: () => isEditInProgressRef.current,
		isSelectionInProgress: () =>
			Boolean(selectionRef.current) || isAreaSelectionInProgressRef.current,
		scrollToHighlight,
		getViewer: () => viewerRef.current,
		getTip: () => tip,
		setTip,
		updateTipPosition: updateTipPositionRef.current,
		getCurrentPage: () => {
			// Return from state if available, otherwise try to get from viewer
			if (currentPage) return currentPage;
			if (viewerRef.current?.currentPageNumber) {
				return viewerRef.current.currentPageNumber;
			}
			return 1; // Default to page 1
		},
		goToPage,
		searchText,
		findNext,
		findPrevious,
		clearSearch,
	};

	utilsRef(pdfHighlighterUtils);

	return (
		<PdfHighlighterContext.Provider value={pdfHighlighterUtils}>
			<div
				ref={containerNodeRef}
				className="PdfHighlighter"
				onPointerDown={handleMouseDown}
				onPointerUp={handleMouseUp}
				style={style}
			>
				<div className="pdfViewer" />
				<style>
					{`
          .textLayer ::selection {
            background: ${textSelectionColor};
          }
        `}
				</style>
				{isViewerReady && (
					<TipContainer
						viewer={viewerRef.current!}
						updateTipPositionRef={updateTipPositionRef}
					/>
				)}
				{isViewerReady && enableAreaSelection && (
					<MouseSelection
						viewer={viewerRef.current!}
						onChange={(isVisible) =>
							(isAreaSelectionInProgressRef.current = isVisible)
						}
						enableAreaSelection={enableAreaSelection}
						style={mouseSelectionStyle}
						onDragStart={() => disableTextSelection(viewerRef.current!, true)}
						onReset={() => {
							selectionRef.current = null;
							disableTextSelection(viewerRef.current!, false);
						}}
						onSelection={(
							viewportPosition,
							scaledPosition,
							image,
							resetSelection,
						) => {
							selectionRef.current = {
								content: { image },
								type: "area",
								position: scaledPosition,
								makeGhostHighlight: () => {
									ghostHighlightRef.current = {
										position: scaledPosition,
										type: "area",
										content: { image },
									};
									onCreateGhostHighlight &&
										onCreateGhostHighlight(ghostHighlightRef.current);
									resetSelection();
									renderHighlightLayers();
									return ghostHighlightRef.current;
								},
							};

							onSelectionFinished && onSelectionFinished(selectionRef.current);
							selectionTip &&
								setTip({ position: viewportPosition, content: selectionTip });
						}}
					/>
				)}
			</div>
		</PdfHighlighterContext.Provider>
	);
};
