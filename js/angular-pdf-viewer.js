/*
 * angular-pdf-viewer v1.2.0
 * https://github.com/jdryg/angular-pdf-viewer
 */
(function (angular, PDFJS, document) {
	"use strict";

	/*
	 * PDF.js link service implementation for the annotation layer.
	 * 
	 * See IPDFLinkService in PDF.js web/interfaces.js for details.
	 * 
	 * Only the functions used by the annotation layer builder are implemented.
	 * NOTE: This implementation is still unfinished (some cases aren't handled
	 * and produce a warning in the console).
	 */
	function PDFLinkService(viewer) {
		this.pagesRefMap = viewer.pagesRefMap;
		this.api = viewer.api;
	}

	PDFLinkService.prototype = {
		getAnchorUrl: function (hash) {
			return hash;
		},
		navigateTo: function (dest) {
			if (typeof dest === 'string') {
				console.warn("PDFLinkService.navigateTo(string) not implemented yet.");
				return;
			}

			if (dest instanceof Array) {
				var destRef = dest[0];
				var pageNumber = destRef instanceof Object ? this.pagesRefMap[destRef.num + ' ' + destRef.gen + ' R'] : (destRef + 1);

				if (pageNumber) {
					this.api.goToPage(pageNumber);
					return;
				}
			}

			console.warn("PDFLinkService.navigateTo(" + (typeof dest) + ") not implemented yet.");
		},
		getDestinationHash: function (dest) {
			if (typeof dest === 'string') {
				return this.getAnchorUrl("#" + escape(dest));
			}

			if (typeof dest === Array) {
				return this.getAnchorUrl("");
			}

			return "";
		},
		executeNamedAction: function (action) {
			// List of actions taken from PDF.js viewer.js
			switch (action) {
				case 'NextPage':
					this.api.goToNextPage();
					break;
				case 'PrevPage':
					this.api.goToPrevPage();
					break;
				case 'LastPage':
					this.api.goToPage(this.api.getNumPages());
					break;
				case 'FirstPage':
					this.api.goToPage(1);
					break;
				case 'GoToPage':
					// Ignore...
					break;
				case 'Find':
					// Ignore...
					break;
				case 'GoBack':
					console.warn("PDFLinkService: GoBack action not implemented yet.");
					break;
				case 'GoForward':
					console.warn("PDFLinkService: GoForward action not implemented yet.");
					break;
				default:
					break;
			}
		}
	};

	angular.module("angular-pdf-viewer", []).
	directive("pdfViewer", [function () {
		// HACK: A LUT for zoom levels because I cannot find a formula that works in all cases.
		var zoomLevelsLUT = [
			0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 
			1.0, 1.1, 1.3, 1.5, 1.7, 1.9, 
			2.0, 2.2, 2.4, 2.6, 2.8, 
			3.0, 3.3, 3.6, 3.9,
			4.0, 4.5,
			5.0
		];

		var pageMargin = 10;

		return {
			restrict: "E",
			scope: {
				src: "@",
				file: "=",
				api: "=",
				initialScale: "@",
				renderTextLayer: "@",
				progressCallback: "&",
				passwordCallback: "&",
				searchTerm: "@",
				searchResultId: "=",
				searchNumOccurences: "=",
				currentPage: "="
			},
			controller: ['$scope', '$element', function ($scope, $element) {
				$scope.pdf = null;
				$scope.pages = [];
				$scope.scale = 1.0;
				$scope.fitWidthScale = 1.0;
				$scope.fitPageScale = 1.0;
				$scope.searchResults = [];
				$scope.searching = false;
				$scope.lastScrollY = 0;
				$scope.pagesRefMap = {};
				$scope.pdfLinkService = null;

				$scope.getContainerSize = function () {
					// Create a tall temp element, add it to the $element
					// and calculate its width. This way we can take into account 
					// the scrollbar width.
					// NOTE: Even if the PDF can fit in a single screen (e.g. 1 
					// page at really small scale level), assuming there will be
					// a scrollbar, doesn't hurt. The page div will be so small 
					// that the difference between left and right margins will not
					// be distinguisable.
					var tallTempElement = angular.element("<div></div>");
					tallTempElement.css("height", "10000px");
					$element.append(tallTempElement);

					var w = tallTempElement[0].offsetWidth;

					tallTempElement.remove();

					var h = $element[0].offsetHeight;
					if(h === 0) {
						// TODO: Should we get the parent height?
						h = 2 * pageMargin;
					}

					// HACK: Allow some space around page.
					// Q: Should this be configurable by the client?
					w -= 2 * pageMargin;
					h -= 2 * pageMargin;

					return {
						width: w,
						height: h
					};
				};

				$scope.downloadProgress = function (progressData) {
					// JD: HACK: Sometimes (depending on the server serving the PDFs) PDF.js doesn't
					// give us the total size of the document (total == undefined). In this case,
					// we guess the total size in order to correctly show a progress bar if needed (even
					// if the actual progress indicator will be incorrect).
					var total = 0;
					if (typeof progressData.total === "undefined") {
						while (total < progressData.loaded) {
							total += 1024 * 1024;
						}
					} else {
						total = progressData.total;
					}

					// Inform the client about the progress...
					if ($scope.progressCallback) {
						$scope.$apply(function () {
							$scope.progressCallback({ 
								operation: "download",
								state: "loading", 
								value: progressData.loaded, 
								total: total,
								message: ""
							});
						});
					}
				};

				$scope.getPDFPassword = function (passwordFunc, reason) {
					var password = "";
					if($scope.passwordCallback) {
						$scope.$apply(function () {
							password = $scope.passwordCallback({reason: reason});

							if(password !== "" && password !== undefined && password !== null) {
								passwordFunc(password);
							} else {
								if ($scope.progressCallback) {
									$scope.progressCallback({ 
										operation: "render",
										state: "failed", 
										value: 1, 
										total: 0,
										message: "A password is required to read this document."
									});
								}
							}
						});
					} else {
						if ($scope.progressCallback) {
							$scope.progressCallback({ 
								operation: "render",
								state: "failed", 
								value: 1, 
								total: 0,
								message: "A password is required to read this document."
							});
						}
					}
				};

				$scope.createPage = function (page, textContent) {
					var pageContainer = angular.element("<div></div>");
					pageContainer.addClass("page");
					pageContainer.attr("id", "page_" + page.pageIndex);

					var canvasElement = angular.element("<canvas></canvas>");
					var textLayerElement = angular.element("<div></div>");
					textLayerElement.addClass("text-layer");

					return {
						id: page.pageIndex + 1,
						pdfPage: page,
						textContent: textContent,
						container: pageContainer,
						canvas: canvasElement,
						textLayer: textLayerElement,
						rendered: false,
						renderTask: null
					};
				};

				$scope.shouldRenderTextLayer = function () {
					if(this.renderTextLayer === "" || this.renderTextLayer === undefined || this.renderTextLayer === null || this.renderTextLayer.toLowerCase() === "false") {
						return false;
					}

					return true;
				};

				$scope.getAllPDFPages = function (pdf, callback) {
					var pageList = [];
					var self = this;

					var remainingPages = pdf.numPages;
					if(this.shouldRenderTextLayer()) {
						for(var iPage = 0;iPage < pdf.numPages;++iPage) {
							pageList.push({});

							var getPageTask = pdf.getPage(iPage + 1);
							getPageTask.then(function (page) {
								// Page reference map. Required by the annotation layer.
								var refStr = page.ref.num + ' ' + page.ref.gen + ' R';
								self.pagesRefMap[refStr] = page.pageIndex + 1;

								var textContentTask = page.getTextContent();
								textContentTask.then(function (textContent) {
									pageList[page.pageIndex] = self.createPage(page, textContent);

									--remainingPages;
									if(remainingPages === 0) {
										self.pdfLinkService = new PDFLinkService(self);
										callback(pageList);
									}
								});
							});
						}
					} else {
						for(var iPage = 0;iPage < pdf.numPages;++iPage) {
							pageList.push({});

							var getPageTask = pdf.getPage(iPage + 1);
							getPageTask.then(function (page) {
								pageList[page.pageIndex] = self.createPage(page, null);

								--remainingPages;
								if(remainingPages === 0) {
									callback(pageList);
								}
							});
						}
					}
				};

				$scope.clearPreviousHighlight = function () {
					if(this.searchResultId <= 0 || this.searchResultId > this.searchResults.length) {
						return;
					}

					var result = this.searchResults[this.searchResultId - 1];
					if(result === null) {
						return;
					}

					var textLayer = this.pages[result.pageID].textLayer;
					if(textLayer === null) {
						return;
					}

					var textDivs = textLayer.children();
					if(textDivs === null || textDivs.length === 0) {
						return;
					}

					if(result.itemID < 0 || result.itemID >= textDivs.length) {
						return;
					}

					var item = textDivs[result.itemID];
					if(item.childNodes.length !== 3) {
						return;
					}

					item.replaceChild(item.childNodes[1].firstChild, item.childNodes[1]);
					item.normalize();
				};

				$scope.highlightItemInPage = function (pageID, itemID, matchPos, text) {
					var textLayer = this.pages[pageID].textLayer;
					if(textLayer === null) {
						return;
					}

					var textDivs = textLayer.children();
					var item = textDivs[itemID];

					var before = item.childNodes[0].nodeValue.substr(0, matchPos);
					var middle = item.childNodes[0].nodeValue.substr(matchPos, text.length);
					var after = document.createTextNode(item.childNodes[0].nodeValue.substr(matchPos + text.length));

					var highlight_span = document.createElement("span");
					highlight_span.className = "highlight";

					highlight_span.appendChild(document.createTextNode(middle));

					item.childNodes[0].nodeValue = before;
					item.childNodes[0].parentNode.insertBefore(after, item.childNodes[0].nextSibling);
					item.childNodes[0].parentNode.insertBefore(highlight_span, item.childNodes[0].nextSibling);

					var curScrollTop = $element[0].scrollTop;
					var containerHeight = $element[0].offsetHeight;

					highlight_span.scrollIntoView();

					var newScrollTop = $element[0].scrollTop;

					var scrolledDown = newScrollTop > curScrollTop;
					var newScrollPosInOldViewport = curScrollTop + containerHeight > newScrollTop;
					var scrolledToEnd = newScrollTop >= $element[0].scrollHeight - containerHeight;

					if(scrolledDown && newScrollPosInOldViewport && !scrolledToEnd) {
						$element[0].scrollTop = curScrollTop;
					} else {
						$element[0].scrollTop -= containerHeight / 4;
					}
				};

				$scope.highlightSearchResult = function (resultID) {
					this.clearPreviousHighlight();

					if(resultID < 0 || resultID >= this.searchResults.length) {
						return;
					}

					var result = this.searchResults[resultID];
					if(result.pageID < 0 || result.pageID >= this.pages.length) {
						return;
					}

					var self = this;
					this.searching = true;
					this.renderPDFPage(result.pageID, this.scale, function () {
						self.highlightItemInPage(result.pageID, result.itemID, result.matchPos, self.searchTerm);
						self.searchResultId = resultID + 1;
						self.searching = false;
					});
				};

				$scope.resetSearch = function () {
					this.clearPreviousHighlight();
					this.searchResults = [];
					this.searchResultId = 0;
					this.searchNumOccurences = 0;
					this.searchTerm = "";
				};

				function trim1 (str) {
					return str.replace(/^\s\s*/, '').replace(/\s\s*$/, '');
				}

				$scope.searchPDF = function (text) {
					if(!this.shouldRenderTextLayer()) {
						return 0;
					}

					this.resetSearch();

					this.searchTerm = text;

					var regex = new RegExp(text, "i");

					var numPages = this.pages.length;
					for(var iPage = 0;iPage < numPages;++iPage) {
						var pageTextContent = this.pages[iPage].textContent;
						if(pageTextContent === null) {
							continue;
						}

						var numItems = pageTextContent.items.length;
						var numItemsSkipped = 0;
						for(var iItem = 0;iItem < numItems;++iItem) {
							// Find all occurrences of text in item string.
							var itemStr = pageTextContent.items[iItem].str;
							itemStr = trim1(itemStr);
							if(itemStr.length === 0) {
								numItemsSkipped++;
								continue;
							}

							var matchPos = itemStr.search(regex);
							var itemStrStartIndex = 0;
							while(matchPos > -1) {
								this.searchResults.push({
									pageID: iPage,
									itemID: iItem - numItemsSkipped,
									matchPos: itemStrStartIndex + matchPos
								});

								itemStr = itemStr.substr(matchPos + text.length);
								itemStrStartIndex += matchPos + text.length;

								matchPos = itemStr.search(regex);
							}
						}
					}

					if(this.searchResults.length > 0) {
						this.highlightSearchResult(0);
					}

					this.searchNumOccurences =  this.searchResults.length;
				};

				$scope.resizePDFPageToScale = function (page, scale) {
					var viewport = page.pdfPage.getViewport(scale);

					page.container.css("width", viewport.width + "px");
					page.container.css("height", viewport.height + "px");

					page.canvas.attr("width", viewport.width);
					page.canvas.attr("height", viewport.height);

					page.textLayer.css("width", viewport.width + "px");
					page.textLayer.css("height", viewport.height + "px");
				};

				$scope.calcPDFScale = function (pageList, desiredScale, containerWidth, containerHeight) {
					if(desiredScale === "fit_width") {
						// Find the widest page in the document and fit it to the container.
						var numPages = pageList.length;
						var maxWidth = pageList[0].pdfPage.getViewport(1.0).width;
						for(var iPage = 1;iPage < numPages;++iPage) {
							maxWidth = Math.max(maxWidth, this.pages[iPage].pdfPage.getViewport(1.0).width);
						}

						return containerWidth / maxWidth;
					} else if(desiredScale === "fit_page") {
						// Find the smaller dimension of the container and fit the 1st page to it.
						var page0Viewport = pageList[0].pdfPage.getViewport(1.0);

						if(containerHeight < containerWidth) {
							return containerHeight / page0Viewport.height;
						}

						return containerWidth / page0Viewport.width;
					}

					var scale = parseFloat(desiredScale);
					if(isNaN(scale)) {
						console.warn("PDF viewer: " + desiredScale + " isn't a valid scale value.");
						return 1.0;
					}

					return scale;
				};

				$scope.isPageInViewport = function (pageContainer) {
					var pageTop = pageContainer[0].offsetTop - $element[0].scrollTop;
					var pageBottom = pageTop + pageContainer[0].offsetHeight;
					return pageBottom >= 0 && pageTop <= $element[0].offsetHeight;
				};

				$scope.renderPDFPage = function (pageID, scale, callback) {
					var self = this;
					var page = this.pages[pageID];

					if(page.rendered) {
						if(page.renderTask === null) {
							if(callback) {
								callback(pageID);
							}
						} else {
							if(callback) {
								page.renderTask.then(function () {
									callback(pageID);
								});
							}
						}

						return;
					}

					var viewport = page.pdfPage.getViewport(scale);

					page.rendered = true;

					page.renderTask = page.pdfPage.render({
						canvasContext: page.canvas[0].getContext('2d'),
						viewport: viewport
					});

					page.renderTask.then(function () {
						page.rendered = true;
						page.renderTask = null;

						page.container.append(page.canvas);

						if(page.textContent) {
							// Render the text layer...
							var textLayerBuilder = new TextLayerBuilder({
								textLayerDiv: page.textLayer[0],
								pageIndex: pageID,
								viewport: viewport
							});

							textLayerBuilder.setTextContent(page.textContent);
							textLayerBuilder.renderLayer();
							page.container.append(page.textLayer);

							// Render the annotation layer...
							// NOTE: Annotation div is inserted into the page div iff
							// there are annotations in the current page. This is 
							// handled by the AnnotationLayerBuilder.
							var annotationLayerBuilder = new AnnotationsLayerBuilder({
								pageDiv: page.container[0],
								pdfPage: page.pdfPage,
								linkService: self.pdfLinkService
							});

							annotationLayerBuilder.setupAnnotations(viewport);
						}

						if(callback !== null) {
							callback(pageID);
						}

						// Inform the client that the page has been rendered.
						if (self.progressCallback) {
							self.$apply(function () {
								self.progressCallback({ 
									operation: "render",
									state: "success",
									value: pageID + 1, 
									total: self.pages.length,
									message: ""
								});
							});
						}
					}, function (message) {
						page.rendered = false;
						page.renderTask = null;

						if(message === "cancelled") {
							console.log("page render task cancelled");
							return;
						}

						// Inform the client that something went wrong while rendering the specified page!
						if (self.progressCallback) {
							self.$apply(function () {
								self.progressCallback({ 
									operation: "render",
									state: "failed",
									value: pageID + 1, 
									total: self.pages.length,
									message: "PDF.js: " + message
								});
							});
						}
					});
				};

				$scope.clearPage = function (pageID) {
					var page = this.pages[pageID];
					if(page.rendered) {
						// Clear the page...
						page.rendered = false;
						page.renderTask = null;
						page.container.empty();
						page.textLayer.empty();
					} else {
						if(page.renderTask !== null) {
							page.renderTask.cancel();

							page.rendered = false;
							page.renderTask = null;
							page.container.empty();
							page.textLayer.empty();
						}
					}
				};

				$scope.removeUnusedPages = function (curPageID) {
					// Keep 5 pages before the current and 5 pages after the current. Remove the rest...
					var numPages = this.pages.length;
					var firstActivePageID = Math.max(curPageID - 5, 0);
					var lastActivePageID = Math.min(curPageID + 5, numPages - 1);

					for(var iPage = 0;iPage < firstActivePageID;++iPage) {
						this.clearPage(iPage);
					}

					for(var iPage = lastActivePageID + 1;iPage < numPages;++iPage) {
						this.clearPage(iPage);
					}
				};

				$scope.renderAllVisiblePages = function (scrollDir) {
					// Since pages are placed one after the other, we can stop the loop once
					// we find a page outside the viewport, iff we've already found one *inside* 
					// the viewport. It helps with large PDFs.
					var numPages = this.pages.length;
					var atLeastOnePageInViewport = false;
					var currentPageID = 0;
					for(var iPage = 0;iPage < numPages;++iPage) {
						var page = this.pages[iPage];

						var inViewport = this.isPageInViewport(page.container);
						if(inViewport) {
							var pageTop = page.container[0].offsetTop - $element[0].scrollTop;
							if(pageTop <= $element[0].offsetHeight / 2) {
								currentPageID = iPage;
							}

							atLeastOnePageInViewport = true;
							this.renderPDFPage(iPage, this.scale, null);
						} else {
							if(atLeastOnePageInViewport) {
								break;
							}
						}
					}

					if(scrollDir !== 0) {
						var nextPageID = currentPageID + scrollDir;
						if(nextPageID >= 0 && nextPageID < numPages) {
							this.renderPDFPage(nextPageID, this.scale, null);
						}
					}

					return currentPageID + 1;
				};

				$scope.onPDFScaleChanged = function (scale) {
					this.scale = scale;

					var numPages = this.pages.length;
					for(var iPage = 0;iPage < numPages;++iPage) {
						// Clear the page's contents...
						this.clearPage(iPage);

						// Resize to current scale...
						this.resizePDFPageToScale(this.pages[iPage], scale);
					}

					this.highlightSearchResult(this.searchResultId - 1);

					this.currentPage = this.renderAllVisiblePages(0);
				};

				$scope.onContainerSizeChanged = function (containerSize) {
					// Calculate fit_width and fit_page scales.
					this.fitWidthScale = this.calcPDFScale(this.pages, "fit_width", containerSize.width, containerSize.height);
					this.fitPageScale = this.calcPDFScale(this.pages, "fit_page", containerSize.width, containerSize.height);

					var scale = this.calcPDFScale(this.pages, this.initialScale, containerSize.width, containerSize.height);
					this.onPDFScaleChanged(scale);
				};

				$scope.onPDFSrcChanged = function () {
					// TODO: Set the correct flag based on client's choice.
					PDFJS.disableTextLayer = false;

					// Since the PDF has changed we must clear the $element.
					this.resetSearch();
					this.pages = [];
					this.lastScrollY = 0;
					this.pdfLinkService = null;
					this.pagesRefMap = {};
					$element.empty();

					var self = this;
					var getDocumentTask = PDFJS.getDocument(this.src, null, this.getPDFPassword, this.downloadProgress);
					getDocumentTask.then(function (pdf) {
						self.pdf = pdf;

						// Get all the pages...
						self.getAllPDFPages(pdf, function (pageList) {
							self.pages = pageList;

							// Append all page containers to the $element...
							for(var iPage = 0;iPage < pageList.length; ++iPage) {
								$element.append(self.pages[iPage].container);
							}

							var containerSize = self.getContainerSize();
							self.onContainerSizeChanged(containerSize);
						});
					}, function (message) {
						// Inform the client that something went wrong and we couldn't read the specified pdf.
						if (self.progressCallback) {
							self.$apply(function () {
								self.progressCallback({ 
									operation: "download",
									state: "failed",
									value: 0,
									total: 0,
									message: "PDF.js: " + message
								});
							});
						}
					});
				};

				$scope.onPDFFileChanged = function () {
					// TODO: Set the correct flag based on client's choice.
					PDFJS.disableTextLayer = false;

					// Since the PDF has changed we must clear the $element.
					this.resetSearch();
					this.pages = [];
					this.lastScrollY = 0;
					this.pdfLinkService = null;
					this.pagesRefMap = {};
					$element.empty();

					var self = this;
					var reader = new FileReader();
					reader.onload = function(e) {
						var arrayBuffer = e.target.result;
						var uint8Array = new Uint8Array(arrayBuffer);

						var getDocumentTask = PDFJS.getDocument(uint8Array, null, self.getPDFPassword, self.downloadProgress);
						getDocumentTask.then(function (pdf) {
							self.pdf = pdf;

							// Get all the pages...
							self.getAllPDFPages(pdf, function (pageList) {
								self.pages = pageList;

								// Append all page containers to the $element...
								for(var iPage = 0;iPage < pageList.length; ++iPage) {
									$element.append(self.pages[iPage].container);
								}

								var containerSize = self.getContainerSize();
								self.onContainerSizeChanged(containerSize);
							});
						}, function (message) {
							// Inform the client that something went wrong and we couldn't read the specified pdf.
							if (self.progressCallback) {
								self.$apply(function () {
									self.progressCallback({ 
										operation: "download",
										state: "failed",
										value: 0,
										total: 0,
										message: "PDF.js: " + message
									});
								});
							}
						});
					};

					reader.onprogress = function (e) {
						self.downloadProgress(e);
					};

					reader.onloadend = function (e) {
						var error = e.target.error;
						if(error !== null) {
							var message = "File API error: ";
							switch(e.code) {
								case error.ENCODING_ERR:
									message += "Encoding error.";
									break;
								case error.NOT_FOUND_ERR:
									message += "File not found.";
									break;
								case error.NOT_READABLE_ERR:
									message += "File could not be read.";
									break;
								case error.SECURITY_ERR:
									message += "Security issue with file.";
									break;
								default:
									message += "Unknown error.";
									break;
							}

							if (self.progressCallback) {
								self.$apply(function () {
									self.progressCallback({ 
										operation: "download",
										state: "failed",
										value: 0,
										total: 0,
										message: message
									});
								});
							}
						}
					};

					reader.readAsArrayBuffer(this.file);
				};

				$element.bind("scroll", function (event) {
					var scrollDir = $element[0].scrollTop - $scope.lastScrollY;
					$scope.lastScrollY = $element[0].scrollTop;

					var curPageID = $scope.renderAllVisiblePages(scrollDir > 0 ? 1 : (scrollDir < 0 ? -1 : 0));
					$scope.removeUnusedPages(curPageID);
					$scope.$apply(function () {
						$scope.currentPage = curPageID;
					});
				});

				// API...
				$scope.api = (function (viewer) {
					return {
						getNextZoomInScale: function (scale) {
							// HACK: This should be possible using an analytic formula!
							var newScale = scale;
							var numZoomLevels = zoomLevelsLUT.length;
							for(var i = 0;i < numZoomLevels;++i) {
								if(zoomLevelsLUT[i] > scale) {
									newScale = zoomLevelsLUT[i];
									break;
								}
							}

							if(scale < viewer.fitWidthScale && newScale > viewer.fitWidthScale) {
								return {
									value: viewer.fitWidthScale,
									label: "Fit width"
								};
							} else if(scale < viewer.fitPageScale && newScale > viewer.fitPageScale) {
								return {
									value: viewer.fitPageScale,
									label: "Fit page"
								};
							}

							return {
								value: newScale,
								label: (newScale * 100.0).toFixed(0) + "%"
							};
						},
						getNextZoomOutScale: function (scale) {
							// HACK: This should be possible using an analytic formula!
							var newScale = scale;
							var numZoomLevels = zoomLevelsLUT.length;
							for(var i = numZoomLevels - 1; i >= 0;--i) {
								if(zoomLevelsLUT[i] < scale) {
									newScale = zoomLevelsLUT[i];
									break;
								}
							}

							if(scale > viewer.fitWidthScale && newScale < viewer.fitWidthScale) {
								return {
									value: viewer.fitWidthScale,
									label: "Fit width"
								};
							} else if(scale > viewer.fitPageScale && newScale < viewer.fitPageScale) {
								return {
									value: viewer.fitPageScale,
									label: "Fit page"
								};
							}

							return {
								value: newScale,
								label: (newScale * 100.0).toFixed(0) + "%"
							};
						},
						zoomTo: function (scale) {
							if(isNaN(parseFloat(scale))) {
								// scale isn't a valid floating point number. Let
								// calcPDFScale() handle it (e.g. fit_width or fit_page).
								var containerSize = viewer.getContainerSize();
								scale = viewer.calcPDFScale(viewer.pages, scale, containerSize.width, containerSize.height);
							}

							viewer.onPDFScaleChanged(scale);
						},
						getZoomLevel: function () {
							return viewer.scale;
						},
						goToPage: function (pageIndex) {
							if(viewer.pdf === null || pageIndex < 1 || pageIndex > viewer.pdf.numPages) {
								return;
							}

							viewer.pages[pageIndex - 1].container[0].scrollIntoView();
						},
						goToNextPage: function () {
							if(viewer.pdf === null) {
								return;
							}

							this.goToPage(viewer.currentPage + 1);
						},
						goToPrevPage: function () {
							if(viewer.pdf === null) {
								return;
							}

							this.goToPage(viewer.currentPage - 1);
						},
						getNumPages: function () {
							if(viewer.pdf === null) {
								return 0;
							}

							return viewer.pdf.numPages;
						},
						findNext: function () {
							if(viewer.searching) {
								return;
							}

							var nextHighlightID = viewer.searchResultId + 1;
							if(nextHighlightID > viewer.searchResults.length) {
								nextHighlightID = 1;
							}

							viewer.highlightSearchResult(nextHighlightID - 1);
						},
						findPrev: function () {
							if(viewer.searching) {
								return;
							}

							var prevHighlightID = viewer.searchResultId - 1;
							if(prevHighlightID <= 0) {
								prevHighlightID = viewer.searchResults.length;
							}

							viewer.highlightSearchResult(prevHighlightID - 1);
						}
					};
				})($scope);
			}],
			link: function (scope, element, attrs) {
				attrs.$observe('src', function (src) {
					if (src !== undefined && src !== null && src !== '') {
						scope.onPDFSrcChanged();
					}
				});

				scope.$watch("file", function (file) {
					if(scope.file !== undefined && scope.file !== null) {
						scope.onPDFFileChanged();
					}
				});

				attrs.$observe("searchTerm", function (searchTerm) {
					if (searchTerm !== undefined && searchTerm !== null && searchTerm !== '') {
						scope.searchPDF(searchTerm);
					} else {
						scope.resetSearch();
					}
				});
			}
		};
	}]);
})(angular, PDFJS, document);
