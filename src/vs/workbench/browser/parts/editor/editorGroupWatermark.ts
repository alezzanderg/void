/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh, isNative, OS } from '../../../../base/common/platform.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { append, clearNode, $, h } from '../../../../base/browser/dom.js';
import { KeybindingLabel } from '../../../../base/browser/ui/keybindingLabel/keybindingLabel.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { defaultKeybindingLabelStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { editorForeground, registerColor, transparent } from '../../../../platform/theme/common/colorRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { isRecentFolder, IWorkspacesService, IRecentFolder } from '../../../../platform/workspaces/common/workspaces.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { ILabelService, Verbosity } from '../../../../platform/label/common/label.js';
import { ColorScheme } from '../../web.api.js';
import { OpenFileFolderAction, OpenFolderAction } from '../../actions/workspaceActions.js';
import { IWindowOpenable } from '../../../../platform/window/common/window.js';
import { splitRecentLabel } from '../../../../base/common/labels.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { Emitter } from '../../../../base/common/event.js';
import { debounce } from '../../../../base/common/decorators.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { URI } from '../../../../base/common/uri.js';

/* eslint-disable */ // Void
import { VOID_CTRL_K_ACTION_ID, VOID_CTRL_L_ACTION_ID } from '../../../contrib/void/browser/actionIDs.js';
import { VIEWLET_ID as REMOTE_EXPLORER_VIEWLET_ID } from '../../../contrib/remote/browser/remoteExplorer.js';
/* eslint-enable */



// Enhanced button configuration
interface WatermarkButton {
	readonly id: string;
	readonly text: string;
	readonly icon?: string;
	readonly action: () => void;
	readonly style?: Partial<CSSStyleDeclaration>;
	readonly className?: string;
	readonly tooltip?: string;
}

// Enhanced recent item interface
interface RecentItem {
	readonly uri: URI;
	readonly label: string;
	readonly fullPath: string;
	readonly isFolder: boolean;
	readonly remoteAuthority?: string;
	readonly lastOpened?: number;
}

/**
 * Advanced watermark component with enhanced features and performance
 */
export class EditorGroupWatermark extends Disposable {
	private readonly _onDidChange = this._register(new Emitter<void>());
	public readonly onDidChange = this._onDidChange.event;

	private readonly shortcuts: HTMLElement;
	private readonly transientDisposables = this._register(new DisposableStore());
	private readonly currentDisposables = new Set<IDisposable>();
	private readonly storageKey = 'editorGroupWatermark.state';

	private workbenchState: WorkbenchState;
	private isEnabled: boolean = true;
	private cachedRecentItems: RecentItem[] = [];
	private lastRenderTime = 0;

	// Performance tracking
	private renderCount = 0;
	private lastPerformanceCheck = 0;

	constructor(
		container: HTMLElement,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IThemeService private readonly themeService: IThemeService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@ICommandService private readonly commandService: ICommandService,
		@IHostService private readonly hostService: IHostService,
		@ILabelService private readonly labelService: ILabelService,
		@IViewsService private readonly viewsService: IViewsService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		// Create enhanced DOM structure
		const elements = h('.editor-group-watermark', [
			h('.letterpress@icon'),
			h('.shortcuts@shortcuts'),
			h('.watermark-overlay@overlay'),
		]);

		append(container, elements.root);
		this.shortcuts = elements.shortcuts;

		// Enhanced void icon styling with better theme support
		this._setupIconStyling(elements.icon);
		this._setupOverlay(elements.overlay);

		this.workbenchState = this.contextService.getWorkbenchState();
		this.isEnabled = this.configurationService.getValue<boolean>('workbench.tips.enabled') ?? true;

		this._registerEnhancedListeners();
		this._loadCachedState();
		this.render();
	}

	/**
	 * Enhanced icon styling with better theme integration
	 */
	private _setupIconStyling(iconElement: HTMLElement): void {
		const updateTheme = () => {
			const theme = this.themeService.getColorTheme().type;
			const isDark = theme === ColorScheme.DARK || theme === ColorScheme.HIGH_CONTRAST_DARK;

			Object.assign(iconElement.style, {
				maxWidth: '220px',
				opacity: '0.5',
				filter: isDark ? '' : 'invert(1)',
				transition: 'filter 0.3s ease, opacity 0.3s ease',
				cursor: 'pointer',
			});

			// Add hover effects
			iconElement.addEventListener('mouseenter', () => {
				iconElement.style.opacity = '0.8';
				iconElement.style.transform = 'scale(1.05)';
			});

			iconElement.addEventListener('mouseleave', () => {
				iconElement.style.opacity = '0.5';
				iconElement.style.transform = 'scale(1)';
			});
		};

		updateTheme();
		this._register(this.themeService.onDidColorThemeChange(updateTheme));
	}

	/**
	 * Setup overlay for additional UI elements
	 */
	private _setupOverlay(overlayElement: HTMLElement): void {
		Object.assign(overlayElement.style, {
			position: 'absolute',
			top: '0',
			left: '0',
			right: '0',
			bottom: '0',
			pointerEvents: 'none',
			zIndex: '1000',
		});
	}

	/**
	 * Enhanced listener registration with better performance
	 */
	private _registerEnhancedListeners(): void {
		// Configuration changes
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('workbench.tips.enabled')) {
				const newEnabled = this.configurationService.getValue<boolean>('workbench.tips.enabled') ?? true;
				if (this.isEnabled !== newEnabled) {
					this.isEnabled = newEnabled;
					this._debouncedRender();
				}
			}
		}));

		// Workbench state changes
		this._register(this.contextService.onDidChangeWorkbenchState(workbenchState => {
			if (this.workbenchState !== workbenchState) {
				this.workbenchState = workbenchState;
				this._debouncedRender();
			}
		}));

		// Keybinding updates
		this._register(this.keybindingService.onDidUpdateKeybindings(() => {
			this._debouncedRender();
		}));

		// Theme changes
		this._register(this.themeService.onDidColorThemeChange(() => {
			this._debouncedRender();
		}));

		// Performance monitoring
		this._registerPerformanceMonitoring();
	}

	/**
	 * Performance monitoring for optimization
	 */
	private _registerPerformanceMonitoring(): void {
		const checkPerformance = () => {
			const now = Date.now();
			if (now - this.lastPerformanceCheck > 60000) { // Every minute
				if (this.renderCount > 100) {
					console.warn('EditorGroupWatermark: High render count detected, consider optimization');
				}
				this.renderCount = 0;
				this.lastPerformanceCheck = now;
			}
		};

		this._register(this.configurationService.onDidChangeConfiguration(checkPerformance));
	}

	/**
	 * Debounced render for better performance
	 */
	@debounce(100)
	private _debouncedRender(): void {
		this.render();
	}

	/**
	 * Enhanced render method with better structure and performance
	 */
	private render(): void {
		if (!this.isEnabled) {
			this.clear();
			return;
		}

		const startTime = performance.now();
		this.renderCount++;

		this.clear();
		this._createWatermarkStructure();
		this._renderContent();

		// Performance tracking
		const renderTime = performance.now() - startTime;
		if (renderTime > 16) { // 60fps threshold
			console.debug(`EditorGroupWatermark render took ${renderTime.toFixed(2)}ms`);
		}

		this._saveCachedState();
		this._onDidChange.fire();
	}

	/**
	 * Create enhanced watermark structure
	 */
	private _createWatermarkStructure(): void {
		// Create main container with better layout
		const mainContainer = append(this.shortcuts, $('.watermark-main-container'));
		Object.assign(mainContainer.style, {
			display: 'flex',
			flexDirection: 'column',
			alignItems: 'center',
			justifyContent: 'center',
			gap: '24px',
			padding: '32px 24px',
			maxWidth: '400px',
			margin: '0 auto',
		});

		// Create icon section
		const iconSection = append(mainContainer, $('.watermark-icon-section'));
		Object.assign(iconSection.style, {
			display: 'flex',
			flexDirection: 'column',
			alignItems: 'center',
			gap: '16px',
			marginBottom: '8px',
		});

		// Create content section
		const contentSection = append(mainContainer, $('.watermark-content-section'));
		Object.assign(contentSection.style, {
			display: 'flex',
			flexDirection: 'column',
			alignItems: 'center',
			gap: '20px',
			width: '100%',
		});

		// Store references for later use
		(this as any)._iconSection = iconSection;
		(this as any)._contentSection = contentSection;
	}

	/**
	 * Enhanced content rendering with better organization
	 */
	private _renderContent(): void {
		const update = async () => {
			try {
				await this._loadRecentItems();
				this._renderBasedOnState();
			} catch (error) {
				console.warn('Failed to render watermark content:', error);
				this._renderFallbackContent();
			}
		};

		update();
		this.transientDisposables.add(this.keybindingService.onDidUpdateKeybindings(update));
	}

	/**
	 * Load recent items with caching
	 */
	private async _loadRecentItems(): Promise<void> {
		if (Date.now() - this.lastRenderTime < 5000) { // 5 second cache
			return;
		}

		try {
			const recentlyOpened = await this.workspacesService.getRecentlyOpened()
				.catch(() => ({ files: [], workspaces: [] }));

			this.cachedRecentItems = recentlyOpened.workspaces
				.filter(isRecentFolder)
				.map(w => {
					const folder = w as IRecentFolder; // Safe because of the filter
					return {
						uri: folder.folderUri,
						label: folder.label || this.labelService.getWorkspaceLabel(folder.folderUri, { verbose: Verbosity.LONG }),
						fullPath: folder.label || this.labelService.getWorkspaceLabel(folder.folderUri, { verbose: Verbosity.LONG }),
						isFolder: true,
						remoteAuthority: folder.remoteAuthority,
						lastOpened: Date.now(), // Placeholder
					};
				})
				.slice(0, 5);

			this.lastRenderTime = Date.now();
		} catch (error) {
			console.warn('Failed to load recent items:', error);
			this.cachedRecentItems = [];
		}
	}

	/**
	 * Render content based on workbench state
	 */
	private _renderBasedOnState(): void {
		if (this.workbenchState === WorkbenchState.EMPTY) {
			this._renderEmptyState();
		} else {
			this._renderWorkspaceState();
		}
	}

	/**
	 * Enhanced empty state rendering
	 */
	private _renderEmptyState(): void {
		const iconSection = (this as any)._iconSection;
		const contentSection = (this as any)._contentSection;

		// Create enhanced button container
		const buttonContainer = this._createButtonContainer();
		iconSection.appendChild(buttonContainer);

		// Add primary actions
		this._addPrimaryActions(buttonContainer);

		// Add recent items with enhanced styling
		if (this.cachedRecentItems.length > 0) {
			this._renderRecentItems(contentSection);
		}
	}

	/**
	 * Create enhanced button container
	 */
	private _createButtonContainer(): HTMLElement {
		const container = $('div');
		Object.assign(container.style, {
			display: 'flex',
			flexDirection: 'column',
			alignItems: 'center',
			gap: '12px',
			marginBottom: '24px',
			width: '100%',
			maxWidth: '280px',
		});
		return container;
	}

	/**
	 * Add primary action buttons with enhanced styling
	 */
	private _addPrimaryActions(container: HTMLElement): void {
		const buttons: WatermarkButton[] = [
			{
				id: 'open-folder',
				text: 'Open Folder',
				icon: '📁',
				action: () => {
					this.commandService.executeCommand(
						isMacintosh && isNative ? OpenFileFolderAction.ID : OpenFolderAction.ID
					);
				},
				className: 'void-openfolder-button',
				style: { width: '124px' },
			},
			{
				id: 'open-ssh',
				text: 'Open SSH',
				icon: '🔗',
				action: () => {
					this.viewsService.openViewContainer(REMOTE_EXPLORER_VIEWLET_ID);
				},
				className: 'void-openssh-button',
				style: {
					width: '124px',
					backgroundColor: '#5a5a5a',
				},
			},
		];

		buttons.forEach(button => {
			const buttonElement = this._createEnhancedButton(button);
			container.appendChild(buttonElement);
		});
	}

	/**
	 * Create enhanced button with better styling and interactions
	 */
	private _createEnhancedButton(config: WatermarkButton): HTMLElement {
		const button = h('button');

		// Apply base styles with improved design
		Object.assign(button.root.style, {
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			gap: '8px',
			padding: '12px 20px',
			border: '1px solid var(--void-button-border, rgba(255,255,255,0.1))',
			borderRadius: '8px',
			background: 'var(--void-button-background, linear-gradient(135deg, #2d2d2d 0%, #3a3a3a 100%))',
			color: 'var(--void-button-foreground, #ffffff)',
			cursor: 'pointer',
			transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
			fontSize: '14px',
			fontWeight: '500',
			letterSpacing: '0.3px',
			width: '100%',
			maxWidth: '200px',
			boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
			...config.style,
		});

		// Add class names
		if (config.className) {
			button.root.classList.add(config.className);
		}

		// Set content with icon if provided
		if (config.icon) {
			const iconSpan = $('span');
			iconSpan.textContent = config.icon;
			iconSpan.style.fontSize = '16px';
			button.root.appendChild(iconSpan);
		}

		const textSpan = $('span');
		textSpan.textContent = config.text;
		button.root.appendChild(textSpan);

		// Add tooltip
		if (config.tooltip) {
			button.root.title = config.tooltip;
		}

		// Add click handler
		button.root.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
			config.action();
		};

		// Add enhanced hover effects
		button.root.addEventListener('mouseenter', () => {
			button.root.style.transform = 'translateY(-2px) scale(1.02)';
			button.root.style.boxShadow = '0 8px 25px rgba(0,0,0,0.25)';
			button.root.style.borderColor = 'var(--void-button-hover-border, rgba(255,255,255,0.2))';
		});

		button.root.addEventListener('mouseleave', () => {
			button.root.style.transform = 'translateY(0) scale(1)';
			button.root.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
			button.root.style.borderColor = 'var(--void-button-border, rgba(255,255,255,0.1))';
		});

		return button.root;
	}

	/**
	 * Enhanced recent items rendering with improved UI
	 */
	private _renderRecentItems(container: HTMLElement): void {
		// Create section container
		const sectionContainer = $('div');
		Object.assign(sectionContainer.style, {
			display: 'flex',
			flexDirection: 'column',
			alignItems: 'center',
			gap: '16px',
			width: '100%',
			maxWidth: '320px',
			padding: '20px',
			backgroundColor: 'var(--void-section-background, rgba(255,255,255,0.03))',
			borderRadius: '12px',
			border: '1px solid var(--void-section-border, rgba(255,255,255,0.05))',
		});

		// Add header with improved styling
		const header = $('div');
		Object.assign(header.style, {
			fontSize: '13px',
			fontWeight: '600',
			color: 'var(--void-text-secondary)',
			textAlign: 'center',
			textTransform: 'uppercase',
			letterSpacing: '1px',
			marginBottom: '4px',
			opacity: '0.8',
		});
		header.textContent = 'Recent Folders';
		sectionContainer.appendChild(header);

		// Add subtitle
		const subtitle = $('div');
		Object.assign(subtitle.style, {
			fontSize: '11px',
			color: 'var(--void-text-secondary)',
			textAlign: 'center',
			opacity: '0.6',
			marginBottom: '16px',
		});
		subtitle.textContent = 'Quick access to your recent projects';
		sectionContainer.appendChild(subtitle);

		// Create items container with better spacing
		const itemsContainer = $('div');
		Object.assign(itemsContainer.style, {
			display: 'flex',
			flexDirection: 'column',
			gap: '8px',
			width: '100%',
		});

		this.cachedRecentItems.forEach((item, index) => {
			const linkElement = this._createRecentItemElement(item, index);
			itemsContainer.appendChild(linkElement);
		});

		sectionContainer.appendChild(itemsContainer);
		container.appendChild(sectionContainer);
	}

	/**
	 * Create enhanced recent item element with improved UI
	 */
	private _createRecentItemElement(item: RecentItem, index: number): HTMLElement {
		const { name, parentPath } = splitRecentLabel(item.fullPath);

		// Create main container with improved design
		const itemContainer = $('div');
		Object.assign(itemContainer.style, {
			display: 'flex',
			alignItems: 'center',
			gap: '12px',
			padding: '12px 16px',
			cursor: 'pointer',
			borderRadius: '8px',
			transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
			border: '1px solid transparent',
			backgroundColor: 'var(--void-item-background)',
			position: 'relative',
			overflow: 'hidden',
		});
		itemContainer.classList.add('void-recent-item');

		// Add subtle gradient overlay
		const gradientOverlay = $('div');
		Object.assign(gradientOverlay.style, {
			position: 'absolute',
			top: '0',
			left: '0',
			right: '0',
			bottom: '0',
			background: 'linear-gradient(135deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.01) 100%)',
			pointerEvents: 'none',
			opacity: '0',
			transition: 'opacity 0.3s ease',
		});
		itemContainer.appendChild(gradientOverlay);

		// Add hover effects
		itemContainer.addEventListener('mouseenter', () => {
			itemContainer.style.backgroundColor = 'var(--void-item-hover-background)';
			itemContainer.style.borderColor = 'var(--void-item-hover-border)';
			itemContainer.style.transform = 'translateX(4px) scale(1.02)';
			itemContainer.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
			gradientOverlay.style.opacity = '1';
		});

		itemContainer.addEventListener('mouseleave', () => {
			itemContainer.style.backgroundColor = 'var(--void-item-background)';
			itemContainer.style.borderColor = 'transparent';
			itemContainer.style.transform = 'translateX(0) scale(1)';
			itemContainer.style.boxShadow = 'none';
			gradientOverlay.style.opacity = '0';
		});

		// Add click handler
		itemContainer.addEventListener('click', (e) => {
			const windowOpenable: IWindowOpenable = { folderUri: item.uri };
			this.hostService.openWindow([windowOpenable], {
				forceNewWindow: e.ctrlKey || e.metaKey,
				remoteAuthority: item.remoteAuthority || null,
			});
			e.preventDefault();
			e.stopPropagation();
		});

		// Create folder icon with improved styling
		const iconSpan = $('span');
		Object.assign(iconSpan.style, {
			fontSize: '16px',
			opacity: '0.8',
			flexShrink: '0',
			width: '20px',
			textAlign: 'center',
		});
		iconSpan.textContent = '📁';
		itemContainer.appendChild(iconSpan);

		// Create text container with better layout
		const textContainer = $('div');
		Object.assign(textContainer.style, {
			display: 'flex',
			flexDirection: 'column',
			gap: '3px',
			flex: '1',
			minWidth: '0', // Allow text to shrink
		});

		// Create name span with improved typography
		const nameSpan = $('span');
		Object.assign(nameSpan.style, {
			fontSize: '13px',
			fontWeight: '600',
			color: 'var(--void-text-primary)',
			whiteSpace: 'nowrap',
			overflow: 'hidden',
			textOverflow: 'ellipsis',
			lineHeight: '1.2',
		});
		nameSpan.textContent = name;
		nameSpan.title = item.fullPath;
		textContainer.appendChild(nameSpan);

		// Create path span with better styling
		const pathSpan = $('span');
		Object.assign(pathSpan.style, {
			fontSize: '11px',
			color: 'var(--void-text-secondary)',
			whiteSpace: 'nowrap',
			overflow: 'hidden',
			textOverflow: 'ellipsis',
			opacity: '0.7',
			lineHeight: '1.2',
		});
		pathSpan.textContent = parentPath;
		pathSpan.title = item.fullPath;
		textContainer.appendChild(pathSpan);

		itemContainer.appendChild(textContainer);

		// Add remote indicator if needed with improved styling
		if (item.remoteAuthority) {
			const remoteIndicator = $('span');
			Object.assign(remoteIndicator.style, {
				fontSize: '12px',
				color: 'var(--void-accent)',
				flexShrink: '0',
				opacity: '0.8',
				marginLeft: '4px',
			});
			remoteIndicator.textContent = '🔗';
			remoteIndicator.title = `Remote: ${item.remoteAuthority}`;
			itemContainer.appendChild(remoteIndicator);
		}

		return itemContainer;
	}

	/**
	 * Enhanced workspace state rendering
	 */
	private _renderWorkspaceState(): void {
		const iconSection = (this as any)._iconSection;

		// Render keybindings with enhanced styling
		this._renderKeybindings(iconSection);
	}

	/**
	 * Render keybindings with enhanced styling
	 */
	private _renderKeybindings(container: HTMLElement): void {
		const keybindings = [
			{ id: VOID_CTRL_L_ACTION_ID, label: 'Chat' },
			{ id: VOID_CTRL_K_ACTION_ID, label: 'Quick Edit' },
		];

		keybindings.forEach(({ id, label }) => {
			const keys = this.keybindingService.lookupKeybinding(id);
			if (!keys) return;

			const dl = append(container, $('dl'));
			const dt = append(dl, $('dt'));
			dt.textContent = label;

			const dd = append(dl, $('dd'));
			const labelElement = new KeybindingLabel(dd, OS, {
				renderUnboundKeybindings: true,
				...defaultKeybindingLabelStyles
			});

			labelElement.set(keys);
			this.currentDisposables.add(labelElement);
		});
	}

	/**
	 * Fallback content when rendering fails
	 */
	private _renderFallbackContent(): void {
		const iconSection = (this as any)._iconSection;
		const fallbackText = $('div');
		fallbackText.textContent = 'Welcome to Void';
		fallbackText.style.textAlign = 'center';
		fallbackText.style.opacity = '0.6';
		iconSection.appendChild(fallbackText);
	}

	/**
	 * Enhanced clear method
	 */
	private clear(): void {
		clearNode(this.shortcuts);
		this.transientDisposables.clear();
		this.currentDisposables.forEach(disposable => disposable.dispose());
		this.currentDisposables.clear();
	}

	/**
	 * Load cached state from storage
	 */
	private _loadCachedState(): void {
		try {
			const cached = this.storageService.get(this.storageKey, StorageScope.PROFILE);
			if (cached) {
				// Parse cached state for future use if needed
				JSON.parse(cached);
				// Apply cached state if needed
			}
		} catch (error) {
			console.warn('Failed to load cached watermark state:', error);
		}
	}

	/**
	 * Save current state to storage
	 */
	private _saveCachedState(): void {
		try {
			const state = {
				lastRenderTime: this.lastRenderTime,
				renderCount: this.renderCount,
				workbenchState: this.workbenchState,
			};
			this.storageService.store(this.storageKey, JSON.stringify(state), StorageScope.PROFILE, StorageTarget.MACHINE);
		} catch (error) {
			console.warn('Failed to save watermark state:', error);
		}
	}

	/**
	 * Public method to force refresh
	 */
	public refresh(): void {
		this._invalidateCache();
		this.render();
	}

	/**
	 * Invalidate cache and force refresh
	 */
	private _invalidateCache(): void {
		this.cachedRecentItems = [];
		this.lastRenderTime = 0;
	}

	override dispose(): void {
		this._saveCachedState();
		super.dispose();
		this.clear();
		this.currentDisposables.forEach(label => label.dispose());
	}
}

// Enhanced color registration
registerColor('editorWatermark.foreground', {
	dark: transparent(editorForeground, 0.6),
	light: transparent(editorForeground, 0.68),
	hcDark: editorForeground,
	hcLight: editorForeground
}, localize('editorLineHighlight', 'Foreground color for the labels in the editor watermark.'));

// Register additional colors for enhanced styling
registerColor('void.button.background', {
	dark: 'linear-gradient(135deg, #2d2d2d 0%, #3a3a3a 100%)',
	light: 'linear-gradient(135deg, #f0f0f0 0%, #e0e0e0 100%)',
	hcDark: 'linear-gradient(135deg, #2d2d2d 0%, #3a3a3a 100%)',
	hcLight: 'linear-gradient(135deg, #f0f0f0 0%, #e0e0e0 100%)'
}, localize('voidButtonBackground', 'Background color for Void watermark buttons.'));

registerColor('void.button.foreground', {
	dark: '#ffffff',
	light: '#000000',
	hcDark: '#ffffff',
	hcLight: '#000000'
}, localize('voidButtonForeground', 'Foreground color for Void watermark buttons.'));

registerColor('void.button.border', {
	dark: 'rgba(255,255,255,0.1)',
	light: 'rgba(0,0,0,0.1)',
	hcDark: 'rgba(255,255,255,0.1)',
	hcLight: 'rgba(0,0,0,0.1)'
}, localize('voidButtonBorder', 'Border color for Void watermark buttons.'));

registerColor('void.button.hover.border', {
	dark: 'rgba(255,255,255,0.2)',
	light: 'rgba(0,0,0,0.2)',
	hcDark: 'rgba(255,255,255,0.2)',
	hcLight: 'rgba(0,0,0,0.2)'
}, localize('voidButtonHoverBorder', 'Hover border color for Void watermark buttons.'));

registerColor('void.section.background', {
	dark: 'rgba(255,255,255,0.03)',
	light: 'rgba(0,0,0,0.03)',
	hcDark: 'rgba(255,255,255,0.03)',
	hcLight: 'rgba(0,0,0,0.03)'
}, localize('voidSectionBackground', 'Background color for Void watermark sections.'));

registerColor('void.section.border', {
	dark: 'rgba(255,255,255,0.05)',
	light: 'rgba(0,0,0,0.05)',
	hcDark: 'rgba(255,255,255,0.05)',
	hcLight: 'rgba(0,0,0,0.05)'
}, localize('voidSectionBorder', 'Border color for Void watermark sections.'));

registerColor('void.link.hover', {
	dark: 'rgba(255,255,255,0.1)',
	light: 'rgba(0,0,0,0.1)',
	hcDark: 'rgba(255,255,255,0.1)',
	hcLight: 'rgba(0,0,0,0.1)'
}, localize('voidLinkHover', 'Hover color for Void watermark links.'));

// Enhanced color registration for recent items
registerColor('void.item.background', {
	dark: 'rgba(255,255,255,0.02)',
	light: 'rgba(0,0,0,0.02)',
	hcDark: 'rgba(255,255,255,0.02)',
	hcLight: 'rgba(0,0,0,0.02)'
}, localize('voidItemBackground', 'Background color for Void recent items.'));

registerColor('void.item.hover.background', {
	dark: 'rgba(255,255,255,0.08)',
	light: 'rgba(0,0,0,0.08)',
	hcDark: 'rgba(255,255,255,0.08)',
	hcLight: 'rgba(0,0,0,0.08)'
}, localize('voidItemHoverBackground', 'Hover background color for Void recent items.'));

registerColor('void.item.hover.border', {
	dark: 'rgba(255,255,255,0.1)',
	light: 'rgba(0,0,0,0.1)',
	hcDark: 'rgba(255,255,255,0.1)',
	hcLight: 'rgba(0,0,0,0.1)'
}, localize('voidItemHoverBorder', 'Hover border color for Void recent items.'));

registerColor('void.text.primary', {
	dark: '#ffffff',
	light: '#000000',
	hcDark: '#ffffff',
	hcLight: '#000000'
}, localize('voidTextPrimary', 'Primary text color for Void watermark.'));

registerColor('void.text.secondary', {
	dark: '#888888',
	light: '#666666',
	hcDark: '#888888',
	hcLight: '#666666'
}, localize('voidTextSecondary', 'Secondary text color for Void watermark.'));

registerColor('void.accent', {
	dark: '#007acc',
	light: '#007acc',
	hcDark: '#007acc',
	hcLight: '#007acc'
}, localize('voidAccent', 'Accent color for Void watermark elements.'));
