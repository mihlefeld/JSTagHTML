/**
 * TagHTML Web Editor - Main Application Logic
 */

// ============================================================================
// State Management
// ============================================================================

class AppState {
    constructor() {
        this.competitionId = '';
        this.competitionData = null;
        this.templateText = '';
        this.lastError = null;
        this.renderedHtml = null;
        this.selectedTemplate = "/JSTagHTML/templates/personal-schedule.html.jinja"
    }

    async loadSelectedTemplate() {
        try {
            const response = await fetch(this.selectedTemplate);
            if (!response.ok) {
                throw new Error(`Failed to load template: ${response.status} ${this.selectedTemplate}`);
            }
            this.templateText = await response.text();
        } catch (error) {
            console.error('Error loading default template:', error);
            this.templateText = `{# Error loading template #}
<!DOCTYPE html>
<html>
<head><title>Error</title></head>
<body><p>Error loading template file.</p></body>
</html>`;
        }
    }

    setCompetitionId(id) {
        this.competitionId = id;
    }

    setCompetitionData(data) {
        this.competitionData = data;
        this.lastError = null;
    }

    setTemplateText(text) {
        this.templateText = text;
    }

    setError(error) {
        this.lastError = error;
    }

    async resetTemplate() {
        await this.loadSelectedTemplate();
    }

    async changeSelectedTemplate(template) {
        this.selectedTemplate = template;
        await this.loadSelectedTemplate();
    }

    setRenderedHtml(html) {
        this.renderedHtml = html;
    }
}

// ============================================================================
// UI Components
// ============================================================================

class UI {
    constructor() {
        this.competitionInput = document.getElementById('competition-id');
        this.fetchButton = document.getElementById('fetch-button');
        this.fetchStatus = document.getElementById('fetch-status');
        this.previewStatus = document.getElementById('preview-status');
        this.previewContainer = document.getElementById('preview');
        this.resetButton = document.getElementById('reset-template-button');
        this.saveSessionButton = document.getElementById('save-session-button');
        this.printButton = document.getElementById('print-button');
        this.selection = document.getElementById('templates-select')
    }

    setFetchStatus(message, isError = false) {
        this.fetchStatus.textContent = message;
        this.fetchStatus.classList.toggle('error', isError);
        this.fetchStatus.classList.toggle('success', !isError);
    }

    setPreviewStatus(message, isError = false) {
        this.previewStatus.textContent = message;
        this.previewStatus.classList.toggle('error', isError);
        this.previewStatus.classList.toggle('success', !isError);
    }

    showPreview(html) {
        this.previewContainer.srcdoc = html;
    }

    showError(message) {
        this.previewContainer.innerHTML = `<div class="error-message"><strong>Error:</strong> ${message}</div>`;
    }

    showPlaceholder() {
        this.previewContainer.innerHTML = '<p class="placeholder">Enter competition ID above and edit the template to see the preview here.</p>';
    }

    getCompetitionId() {
        return this.competitionInput.value.trim();
    }

    setCompetitionIdInput(id) {
        this.competitionInput.value = id;
    }
}

// ============================================================================
// API & Data Fetching
// ============================================================================

class WCAClient {
    static API_BASE = 'https://www.worldcubeassociation.org/api/v0';

    static async fetchCompetition(competitionId) {
        const url = `${this.API_BASE}/competitions/${competitionId}/wcif/public`;
        
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`API returned ${response.status}: ${response.statusText}`);
            }
            const data = await response.json();
            return data;
        } catch (error) {
            throw new Error(`Failed to fetch competition data: ${error.message}`);
        }
    }

    /**
     * Build an activities map from the schedule, keyed by activityId
     * Maps activityId -> { event, round, group, start_end_time, start_time, end_time, room_name }
     */
    static buildActivitiesMap(schedule) {
        const fine_activities = {};
        const coarse_activities = {};
        
        if (!schedule || !schedule.venues) {
            return fine_activities;
        }

        for (const venue of schedule.venues) {
            if (!venue.rooms) continue;
            
            for (const room of venue.rooms) {
                if (!room.activities) continue;
                
                for (const activity of room.activities) {
                    let childActivities = activity.childActivities || [];
                    
                    // If no childActivities and not an "other" activity, treat activity itself as child
                    if (childActivities.length === 0 && !activity.activityCode.includes('other')) {
                        childActivities = [activity];
                    }
                    const [event, round] = activity.activityCode.split('-').slice(0, 2);
                    const startTime = new Date(activity.startTime);
                    const endTime = new Date(activity.endTime);

                    coarse_activities[activity.id] = {
                        id: activity.id,
                        name: activity.name,
                        event: event,
                        round: round,
                        round_start: startTime,
                        round_end: endTime,
                        room: room,
                        venue: venue,
                        duration: (endTime - startTime) / (1000 * 60)
                    };
                    
                    for (const childActivity of childActivities) {
                        try {
                            const [event, round, group] = childActivity.activityCode.split('-').slice(0, 3);
                            
                            const groupStartTime = new Date(childActivity.startTime);
                            const groupEndTime = new Date(childActivity.endTime);
                            
                            const startStr = startTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
                            const endStr = endTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
                            
                            fine_activities[childActivity.id] = {
                                id: childActivity.id,
                                name: childActivity.name,
                                event: event,
                                round: parseInt(round.substring(1)),
                                group: parseInt(group.substring(1)),
                                round_start: startTime,
                                round_end: endTime,
                                round_duration: (endTime - startTime) / (1000 * 60),
                                group_start: groupStartTime,
                                group_end: groupEndTime,
                                group_duration: (groupEndTime - groupStartTime) / (1000 * 60),
                                room: room.name.toLowerCase().replace(/\s+/g, '-'),
                                venue: venue
                            };
                        } catch (e) {
                            // Skip malformed activity codes
                            continue;
                        }
                    }
                }
            }
        }
        
        return {coarse: coarse_activities, fine: fine_activities};
    }

    /**
     * Build competitor assignments, resolving activityIds to actual activity data
     */
    static buildCompetitorAssignments(wcifData, activities) {
        const fine_activities = activities.fine;
        const coarse_activities = activities.coarse;
        const locale = "en-us";
        const formatter = new Intl.DateTimeFormat(locale, {
            weekday: 'short'
        });
        const assignments = {};
        
        if (!wcifData.persons) {
            return assignments;
        }

        for (const person of wcifData.persons) {
            const personAssignments = [];
            
            if (!person.assignments) continue;
            
            for (const assignment of person.assignments) {
                const activityId = assignment.activityId;
                
                if (!(activityId in fine_activities)) {
                    // Activity not found in our map, skip
                    continue;
                }
                
                const activity = fine_activities[activityId];
                
                try {
                    let role = assignment.assignmentCode
                        .replace('staff-', '')
                        .replace('stagelead', 'lead');
                    
                    const validRoles = ['competitor', 'runner', 'judge', 'scrambler', 'delegate', 'lead'];
                    if (!validRoles.includes(role)) {
                        continue;
                    }
                    
                    personAssignments.push({
                        activity_id: activityId,
                        event: activity.event,
                        round: activity.round,
                        group: activity.group,
                        role: role,
                        start_end_time: activity.start_end_time,
                        start_time: activity.start_time,
                        end_time: activity.end_time,
                        room_name: activity.room_name,
                        day: activity.group_start.getDay(),
                    });
                } catch (e) {
                    // Skip malformed assignments
                    continue;
                }
            }
            
            const personGroupSchedule = [];
            for (const [key, activity] of Object.entries(fine_activities)) {
                var role_assignments = [];
                for (const assignment of personAssignments) {
                    if ((assignment.event == activity.event) && (assignment.round == activity.round) && (assignment.group == activity.group)) {
                        role_assignments.push(assignment.role);
                    }
                }
                personGroupSchedule.push(
                    {
                        activity: activity, 
                        roles: role_assignments,
                    }
                )
            }
            personGroupSchedule.sort((a, b) => a.activity.group_start - b.activity.group_start);
            
            const personRoundSchedule = [];
            for (const [key, activity] of Object.entries(coarse_activities)) {
                var role_assignments = [];
                for (const assignment of personAssignments) {
                    if (assignment.event == activity.event && 'r' + assignment.round == activity.round) {
                        role_assignments.push(
                            {
                                'role': assignment.role,
                                'group': assignment.group
                            }
                        );
                    }
                }
                role_assignments.sort((a, b) => a.group - b.group)
                personRoundSchedule.push(
                    {
                        activity: activity, 
                        roles: role_assignments,
                    }
                )
            }
            personRoundSchedule.sort((a, b) => a.activity.round_start - b.activity.round_start);

            assignments[person.registrantId] = {
                assignments: personAssignments,
                group_schedule: personGroupSchedule,
                round_schedule: personRoundSchedule,
            };
        }
        
        return assignments;
    }

    /**
     * Transform raw WCA API data into a simpler format for templating
     */
    static transformData(wcifData) {
        // Build activities and assignments maps
        const activities = this.buildActivitiesMap(wcifData.schedule);
        const competitorAssignments = this.buildCompetitorAssignments(wcifData, activities);

        const persons = wcifData.persons || [];
        const events = wcifData.events || [];

        // Build person-focused data structure with resolved assignments
        const transformedPersons = persons.map(person => {
            const assignments = competitorAssignments[person.registrantId] || [];
            
            return {
                id: person.registrantId,
                name: person.name,
                wcaId: person.wcaId,
                countryIso2: person.countryIso2,
                gender: person.gender,
                avatar: person.avatar,
                personalBests: person.personalBests,
                registration: {
                    role: person.registration?.role || 'COMPETITOR'
                },
                schedule: assignments
            };
        });

        return {
            competition: {
                id: wcifData.id,
                name: wcifData.name,
                start_date: wcifData.startDate,
                end_date: wcifData.endDate,
                country_iso2: wcifData.country?.iso2
            },
            persons: transformedPersons,
            events: events.map(e => ({
                id: e.id,
                name: e.name
            })),
            meta: {
                total_persons: persons.length,
                total_events: events.length
            },
            // Include the raw data and preprocessing results for advanced users
            activities: activities,
            competitor_assignments: competitorAssignments,
            raw: wcifData
        };
    }
}

// ============================================================================
// Template Rendering
// ============================================================================

const uploadedFiles = new Map(); // key: filename, value: { name, type, size, dataUrl, text }

const templateFilesInput = document.getElementById("template-files-input");
const clearFilesButton = document.getElementById("clear-files-button");
const filesStatus = document.getElementById("files-status");

function isLikelyTextFile(file) {
    const textType = file.type && file.type.startsWith("text/");
    const textExt = /\.(txt|json|csv|xml|svg|html?|css|js|md|yaml|yml)$/i.test(file.name);
    return textType || textExt;
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

async function addUploadedFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const file of files) {
        const dataUrl = await readFileAsDataUrl(file);
        let text = null;
        if (isLikelyTextFile(file)) {
            try {
                text = await file.text();
            } catch {
                text = null;
            }
        }

        uploadedFiles.set(file.name, {
            name: file.name,
            type: file.type || "application/octet-stream",
            size: file.size,
            dataUrl,
            text
        });
    }

    if (filesStatus) {
        filesStatus.textContent = `${uploadedFiles.size} file(s) loaded`;
    }
}

function buildUploadedFilesContext() {
    const files = {};
    for (const [name, file] of uploadedFiles.entries()) {
        files[name] = {
            name: file.name,
            type: file.type,
            size: file.size,
            url: file.dataUrl,   // data URL for <img>, <link>, etc.
            text: file.text      // text content if readable
        };
    }

    return {
        files,
        file_url: (name) => (files[name] ? files[name].url : ""),
        file_text: (name) => (files[name] ? (files[name].text || "") : "")
    };
}

if (templateFilesInput) {
    templateFilesInput.addEventListener("change", async (e) => {
        await addUploadedFiles(e.target.files);
        // Re-render preview after file load
        if (typeof renderPreview === "function") {
            renderPreview();
        }
    });
}

if (clearFilesButton) {
    clearFilesButton.addEventListener("click", () => {
        uploadedFiles.clear();
        if (templateFilesInput) templateFilesInput.value = "";
        if (filesStatus) filesStatus.textContent = "No files loaded";
        if (typeof renderPreview === "function") {
            renderPreview();
        }
    });
}

class TemplateRenderer {
    /**
     * Render a Jinja2 template with the given context using Nunjucks (Jinja2-compatible)
     */
    static render(templateText, context) {
        try {
            // The 'nunjucks' library is loaded from CDN
            if (typeof nunjucks === 'undefined') {
                throw new Error('Nunjucks library not loaded. Please check your internet connection.');
            }
            var env = new nunjucks.Environment();
            env.addFilter('dictkeysort', (data, key) => {
                return Object.values(data).toSorted((a, b) => {return a[key] >= b[key];});
            });
            env.addFilter('keylist', (data, key) => {
                return Object.values(data).map((obj) => obj[key]);
            });

            const uploadedContext = buildUploadedFilesContext();

            const fullContext = {
                ...context,
                ...uploadedContext
            }
            
            // Compile and render the template
            const html = env.renderString(templateText, fullContext);
            return html;
        } catch (error) {
            console.log(error);
            throw new Error(`Template render error: ${error.message}`);
        }
    }

    /**
     * Render the full page template with all competition data
     */
    static renderFullPage(templateText, transformedData) {
        // Render the entire template with all data at once
        const html = this.render(templateText, transformedData);
        return html;
    }
}

// ============================================================================
// Application Controller
// ============================================================================

class Application {
    constructor() {
        this.state = new AppState();
        this.ui = new UI();
        this.editor = null;
    }

    async init() {
        await this.loadTemplate();
        this.initEditor();
        this.attachEventListeners();
        this.loadSessionState();
    }

    async loadTemplate() {
        await this.state.loadSelectedTemplate();
    }

    initEditor() {
        // Initialize Ace Editor
        this.editor = ace.edit('editor');
        this.editor.setTheme('ace/theme/chrome');
        // Try to use jinja2 mode; fall back to html if unavailable
        try {
            this.editor.session.setMode('ace/mode/jinja2');
        } catch (e) {
            console.warn('Jinja2 mode not available, using HTML mode', e);
            this.editor.session.setMode('ace/mode/html');
        }
        this.editor.session.setValue(this.state.templateText);
        this.editor.setOptions({
            fontSize: 13,
            showPrintMargin: false,
            highlightActiveLine: true,
            tabSize: 2
        });
    }

    attachEventListeners() {
        // Fetch button
        this.ui.fetchButton.addEventListener('click', () => this.handleFetchCompetition());

        // Reset template button
        this.ui.resetButton.addEventListener('click', () => this.handleResetTemplate());

        // Save session button
        this.ui.saveSessionButton.addEventListener('click', () => this.handleSaveSession());

        // Print button
        this.ui.printButton.addEventListener('click', () => this.handlePrint());

        // Template selection
        this.ui.selection.addEventListener('change', (event) => {
            this.state.changeSelectedTemplate(event.target.value); 
            this.handleResetTemplate();
        });

        // Live template editing
        this.editor.session.on('change', () => {
            this.state.setTemplateText(this.editor.getValue());
            this.renderPreview();
        });

        // Enter key to fetch (shortcut)
        this.ui.competitionInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.handleFetchCompetition();
            }
        });
    }

    async handleFetchCompetition() {
        const competitionId = this.ui.getCompetitionId();

        if (!competitionId) {
            this.ui.setFetchStatus('Please enter a competition ID', true);
            return;
        }

        this.ui.setFetchStatus('Fetching...');
        this.ui.fetchButton.disabled = true;

        try {
            const wcifData = await WCAClient.fetchCompetition(competitionId);
            const transformedData = WCAClient.transformData(wcifData);

            this.state.setCompetitionId(competitionId);
            this.state.setCompetitionData(transformedData);

            this.ui.setFetchStatus(`✓ Loaded ${transformedData.meta.total_persons} competitors`, false);
            this.renderPreview();

            // Save to session
            this.saveSessionState();
        } catch (error) {
            this.state.setError(error.message);
            this.ui.setFetchStatus(`✗ ${error.message}`, true);
            this.ui.showError(error.message);
        } finally {
            this.ui.fetchButton.disabled = false;
        }
    }

    renderPreview() {
        if (!this.state.competitionData) {
            this.ui.showPlaceholder();
            return;
        }

        try {
            const html = TemplateRenderer.renderFullPage(
                this.state.templateText,
                this.state.competitionData
            );
            this.state.setRenderedHtml(html);
            this.ui.showPreview(html);
            this.ui.setPreviewStatus('Ready', false);
        } catch (error) {
            this.ui.showError(error.message);
            this.ui.setPreviewStatus('Render error', true);
        }
    }

    async handleResetTemplate() {
        if (confirm(`Reset template to ${this.state.selectedTemplate}? This will discard your changes.`)) {
            await this.state.resetTemplate();
            this.editor.session.setValue(this.state.templateText);
            this.renderPreview();
        }
    }

    handleSaveSession() {
        this.saveSessionState();
        this.ui.setPreviewStatus('Session saved!', false);
    }

    handlePrint() {
        if (!this.state.competitionData) {
            alert('Please fetch competition data first.');
            return;
        }

        // Open a new window with only the rendered template HTML and print it
        const printWindow = window.open('', '_blank');
        printWindow.document.write(this.state.renderedHtml);
        printWindow.document.close();
        printWindow.print();
        printWindow.close();
    }

    saveSessionState() {
        const sessionData = {
            competitionId: this.state.competitionId,
            templateText: this.state.templateText,
            timestamp: new Date().toISOString()
        };
        localStorage.setItem('taghtml-session', JSON.stringify(sessionData));
    }

    loadSessionState() {
        const saved = localStorage.getItem('taghtml-session');
        if (saved) {
            try {
                const session = JSON.parse(saved);
                this.ui.setCompetitionIdInput(session.competitionId);
                this.editor.session.setValue(session.templateText);
                this.state.setTemplateText(session.templateText);
            } catch (e) {
                console.warn('Failed to load session:', e);
            }
        }
    }
}

// ============================================================================
// Initialize Application
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
    window.app = new Application();
    await window.app.init();
});
