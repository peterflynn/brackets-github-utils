/*
 * Copyright (c) 2013-2015 Peter Flynn.
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */


/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50, regexp: true, evil: true */
/*global define, brackets, $ */

define(function (require, exports, module) {
    "use strict";
    
    // Brackets modules
    var _                   = brackets.getModule("thirdparty/lodash"),
        CommandManager      = brackets.getModule("command/CommandManager"),
        QuickOpen           = brackets.getModule("search/QuickOpen"),
        ProjectManager      = brackets.getModule("project/ProjectManager"),
        Menus               = brackets.getModule("command/Menus"),
        Dialogs             = brackets.getModule("widgets/Dialogs"),
        DefaultDialogs      = brackets.getModule("widgets/DefaultDialogs"),
        NativeApp           = brackets.getModule("utils/NativeApp"),
        EditorManager       = brackets.getModule("editor/EditorManager"),
        MainViewManager     = brackets.getModule("view/MainViewManager"),
        PreferencesManager  = brackets.getModule("preferences/PreferencesManager");
    
    var prefs = PreferencesManager.getExtensionPrefs("github-utils");
    
    prefs.definePreference("githubURL", "string", "", { description: "GitHub project URL for the current project (set this separately in each project's .brackets.json file)" });
    
    function errorDialog(message) {
        Dialogs.showModalDialog(DefaultDialogs.DIALOG_ID_ERROR, "GitHub Configuration", message).done(function () {
            MainViewManager.focusActivePane();
        });
    }
    
    /**
     * @return {?{repoURL:string, relPath:string}}  null if misconfiured or path lies outside project
     */
    function findRemotePathInfo(fullPath) {
        var relPath = ProjectManager.makeProjectRelativeIfPossible(fullPath);
        if (relPath === fullPath) {
            errorDialog("This file lies outside the project's Git repo.");
            return null;
        }
        
        var repoURL = prefs.get("githubURL");
        if (!repoURL) {
            errorDialog("Create a .brackets.json file in the root of your project, and set the \"github-utils.githubURL\" preference to the URL for your project on GitHub.");
            return null;
        } else {
            if (!repoURL.match(/https?:\/\//)) {
                errorDialog("The \"github-utils.githubURL\" preference is not a valid URL: " + _.escape(repoURL));
                return null;
            }
            
            if (repoURL[repoURL.length - 1] === "/") {
                // Strip trailing "/" for cleaner concatenation
                repoURL = repoURL.substr(0, repoURL.length - 1);
            }
            return { repoURL: repoURL, relPath: relPath };
        }
    }
    
    
    var searchPromise;
    var latestQuery;
    
    /**
     * @param {SearchResult} selectedItem
     */
    function itemSelect(selectedItem) {
        var pathInfo = findRemotePathInfo(selectedItem.fullPath);
        if (pathInfo) {
            NativeApp.openURLInDefaultBrowser(pathInfo.repoURL + "/blob/master/" + pathInfo.relPath);
        }
    }
    
    /**
     * @param {!string} query
     * @param {!Array.<FileInfo>} fileList
     * @param {!StringMatcher} matcher
     */
    function doSearch(query, fileList, matcher) {
        query = query.substr(1);  // lose the ">" prefix
        
        // TODO: this part copied from QuickOpen.searchFileList()
        // First pass: filter based on search string; convert to SearchResults containing extra info
        // for sorting & display
        var filteredList = $.map(fileList, function (fileInfo) {
            // Is it a match at all?
            // match query against the full path (with gaps between query characters allowed)
            var searchResult = matcher.match(ProjectManager.makeProjectRelativeIfPossible(fileInfo.fullPath), query);
            if (searchResult) {
                searchResult.label = fileInfo.name;
                searchResult.fullPath = fileInfo.fullPath;
            }
            return searchResult;
        });
        
        // Sort by "match goodness" tier first; break ties alphabetically by short filename
        QuickOpen.basicMatchSort(filteredList);
        
        return filteredList;
    }
    
    /**
     * @param {string} query User query/filter string
     * @return {Array.<SearchResult>|$.Promise} Sorted and filtered results that match the query, or a promise
     *      resolved with such an array later.
     */
    function search(query, matcher) {
        // We're useless if there's no file open to insert text into
        if (!EditorManager.getActiveEditor()) {
            return [];
        }
        
        // We're already async waiting on files list, nothing more we can do yet
        if (searchPromise) {
            latestQuery = query;
            return searchPromise;
        }
        
        var fileList;
        
        var fileListPromise = ProjectManager.getAllFiles()
            .done(function (result) {
                fileList = result;
            });
        
        if (fileListPromise.state() === "resolved") {
            return doSearch(query, fileList, matcher);
        } else {
            // Index isn't built yet - start waiting
            latestQuery = query;
            searchPromise = new $.Deferred();
            fileListPromise.done(function () {
                searchPromise.resolve(doSearch(latestQuery, fileList, matcher));
                searchPromise = null;
                latestQuery = null;
            });
            return searchPromise.promise();
        }
    }
    
    /**
     * @param {SearchResult} fileEntry
     * @param {string} query
     * @return {string}
     */
    function resultFormatter(item, query) {
        // TODO: copied from QuickOpen._filenameResultsFormatter()
        
        // For main label, we just want filename: drop most of the string
        function fileNameFilter(includesLastSegment, rangeText) {
            if (includesLastSegment) {
                var rightmostSlash = rangeText.lastIndexOf('/');
                return rangeText.substring(rightmostSlash + 1);  // safe even if rightmostSlash is -1
            } else {
                return "";
            }
        }
        var displayName = QuickOpen.highlightMatch(item, null, fileNameFilter);
        var displayPath = QuickOpen.highlightMatch(item, "quicksearch-pathmatch");
        
        return "<li>" + displayName + "<br /><span class='quick-open-path'>" + displayPath + "</span></li>";
    }
    
    /**
     * @param {string} query
     * @return {boolean} true if this plugin wants to provide results for this query
     */
    function match(query) {
        return query[0] === ">";
    }
    
    // Register as a new Quick Open mode
    QuickOpen.addQuickOpenPlugin(
        {
            name: "Go to on GitHub",
            label: "Go to on GitHub",
            languageIds: [],  // empty array = all file types
            done: function () {},
            search: search,
            match: match,
            itemFocus: function () {},
            itemSelect: itemSelect,
            resultsFormatter: resultFormatter,
            matcherOptions: { segmentedSearch: true }
        }
    );
    
    
    // Command to search for any file via Quick Open, then jump to that same file on GH
    function handleGoto() {
        var currentEditor = EditorManager.getActiveEditor(),
            currentFile = currentEditor && currentEditor.document.file.name;
        
        
        // Begin Quick Open in our search mode
        QuickOpen.beginSearch(">", currentFile);
        
        // TODO: if file currently open in an editor, append line number to final URL
        // TODO: support manually-typed in :nn syntax to go to line too?
    }
    
    // Command to jump to the current line of the current file in GH's 'git blame' view
    function handleBlame() {
        var editor = EditorManager.getFocusedEditor();
        if (!editor) { return; }
        
        var line = editor.getCursorPos().line;
        
        var pathInfo = findRemotePathInfo(editor.document.file.fullPath);
        if (pathInfo) {
            NativeApp.openURLInDefaultBrowser(pathInfo.repoURL + "/blame/master/" + pathInfo.relPath + "#L" + (line + 1));
        }
    }
    
    // Expose commands in UI
    var CMD_BLAME = "pflynn.ghutils.blame";
    CommandManager.register("Git Blame", CMD_BLAME, handleBlame);
    
    var menu = Menus.getMenu(Menus.AppMenuBar.NAVIGATE_MENU);
    menu.addMenuDivider(Menus.LAST);
    menu.addMenuItem(CMD_BLAME, null, Menus.LAST);
    
    
    var CMD_GOTO = "pflynn.ghutils.viewFile";
    CommandManager.register("Go to on GitHub...", CMD_GOTO, handleGoto);
    
    menu = Menus.getMenu(Menus.AppMenuBar.NAVIGATE_MENU);
    var shortcut = [
        { "key": "Ctrl-Shift-G" },
        { "key": "Ctrl-Shift-G", "platform": "mac" }
    ];
    menu.addMenuItem(CMD_GOTO, shortcut, Menus.LAST);
});