import type { RequestHandler } from './$types';

const tableListUrl =
	'https://script.google.com/macros/s/AKfycbzaQbcI9UZDcDlSHHl2NHilhmePrNrwxRdOFkmIXsfnbfksKKmAB3V65WZ8jPWU-7E/exec?table=tablelist';

export const GET: RequestHandler = () => {
	return new Response(null, {
		status: 302,
		headers: {
			location: tableListUrl,
			'cache-control': 'no-store'
		}
	});
};
